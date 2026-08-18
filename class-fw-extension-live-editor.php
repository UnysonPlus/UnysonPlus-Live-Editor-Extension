<?php if ( ! defined( 'FW' ) ) {
	die( 'Forbidden' );
}

/**
 * Class FW_Extension_Live_Editor
 *
 * Avada-style live front-end editor for the Page Builder.
 *
 * Architecture (decided up-front so later phases don't rework it):
 *
 *   - The editor is an ISOLATED IFRAME canvas. Visiting a builder page with
 *     `?fw-live-editor=1` swaps the normal theme template for a minimal editor
 *     "shell" ({@see views/editor-shell.php}) — a full-screen chrome (toolbar +
 *     canvas area) that embeds the very same page in an <iframe>, loaded with
 *     `?fw-live-editor-frame=1`. Editor CSS/JS never collide with theme CSS/JS
 *     because they live in different documents; the two talk over postMessage.
 *
 *   - The data model is the EXISTING page-builder value. We read the builder
 *     JSON straight out of the `page-builder` post option (the same value the
 *     classic backend builder edits) and, in later phases, write it back the
 *     same way — so the live editor and the classic builder are two front-ends
 *     over one source of truth, and frontend rendering / saving are untouched.
 *
 * Phase 0 (this file): the entry point + boot plumbing only — the "Edit Live"
 * admin-bar button, the shell/frame request routing, asset enqueuing and the
 * builder-data hand-off to JS. Selection outlines (Phase 1), inline option
 * editing (Phase 2) and saving (Phase 3) build on top of this shell.
 */
class FW_Extension_Live_Editor extends FW_Extension {

	/** Post meta holding the background recovery autosave (separate from the live
	 *  page-builder content). */
	const AUTOSAVE_META = '_fw_le_autosave';

	/** Revision history: a small index meta (list metadata) + one meta per
	 *  revision holding the full model JSON; capped at REVISIONS_MAX (oldest
	 *  trimmed) AND at REVISIONS_MAX_BYTES in total.
	 *
	 *  The byte cap is the load-bearing one. A revision holds the FULL builder
	 *  model JSON, which on a rich page runs to about 1 MB, so a count-only cap
	 *  of 20 permits ~20 MB of postmeta on a single post. That is not merely
	 *  disk: WordPress caches post meta PER POST, not per key, so the first
	 *  get_post_meta() call for any key loads every row the post owns. Measured
	 *  on a real page carrying 11.5 MB of revisions, one innocuous
	 *  get_post_meta( $id, '_wp_page_template' ) pulled 42 MB into memory — the
	 *  stored bytes expand roughly 3.6x as live PHP strings — and that happens
	 *  on any request touching that post's meta at all.
	 *
	 *  REVISIONS_MIN_KEEP is the deliberate escape hatch: a page whose single
	 *  revision already exceeds the budget would otherwise keep no history at
	 *  all, so the floor wins over the cap. A page with enormous revisions can
	 *  therefore still exceed the budget; that case wants compression, not a
	 *  smaller cap. */
	const REVISIONS_INDEX_META = '_fw_le_rev_index';
	const REVISION_META_PREFIX = '_fw_le_rev_';
	const REVISIONS_MAX        = 20;
	const REVISIONS_MAX_BYTES  = 3145728; // 3 MB of stored JSON per post.
	const REVISIONS_MIN_KEEP   = 2;       // Always keep at least this many.

	/** Query var that boots the editor shell (the chrome around the iframe). */
	private $boot_query_var = 'fw-live-editor';

	/** Query var that marks the document loaded INSIDE the iframe (the canvas). */
	private $frame_query_var = 'fw-live-editor-frame';

	/**
	 * @internal
	 */
	protected function _init() {
		// Admin-bar button is wanted both on the front-end (while viewing a page)
		// and on the wp-admin post-edit screen, so it is registered unconditionally.
		add_action( 'admin_bar_menu', array( $this, '_action_admin_bar_menu' ), 90 );

		// Entry points into the live editor from wp-admin: a button in the Publish
		// box on the post-edit screen, and a hover row-action in the Pages/Posts
		// list table (like "Edit with Elementor").
		add_action( 'post_submitbox_misc_actions', array( $this, '_action_submitbox_edit_live' ) );
		add_filter( 'page_row_actions', array( $this, '_filter_row_actions' ), 10, 2 );
		add_filter( 'post_row_actions', array( $this, '_filter_row_actions' ), 10, 2 );

		// --- AJAX (admin-ajax.php runs in is_admin() context). ---
		add_action( 'wp_ajax_fw_live_editor_item_options', array( $this, '_ajax_item_options' ) );
		add_action( 'wp_ajax_fw_live_editor_render_item', array( $this, '_ajax_render_item' ) );
		add_action( 'wp_ajax_fw_live_editor_new_item', array( $this, '_ajax_new_item' ) );
		add_action( 'wp_ajax_fw_live_editor_new_section', array( $this, '_ajax_new_section' ) );
		add_action( 'wp_ajax_fw_live_editor_new_column', array( $this, '_ajax_new_column' ) );
		add_action( 'wp_ajax_fw_live_editor_new_container', array( $this, '_ajax_new_container' ) );
		add_action( 'wp_ajax_fw_live_editor_render_page', array( $this, '_ajax_render_page' ) );
		add_action( 'wp_ajax_fw_live_editor_save', array( $this, '_ajax_save' ) );
		add_action( 'wp_ajax_fw_live_editor_autosave', array( $this, '_ajax_autosave' ) );
		add_action( 'wp_ajax_fw_live_editor_revisions', array( $this, '_ajax_revisions' ) );
		add_action( 'wp_ajax_fw_live_editor_revision_get', array( $this, '_ajax_revision_get' ) );
		add_action( 'wp_ajax_fw_live_editor_opcache_flush', array( $this, '_ajax_opcache_flush' ) );

		// Snapshot a revision whenever the builder content is saved through ANY
		// editor (the live editor's _ajax_save AND the classic backend builder both
		// go through fw_set_db_post_option, which fires this). The dedupe in
		// store_revision() keeps the shared history free of duplicates.
		add_action( 'fw_post_options_update', array( $this, '_action_snapshot_revision' ), 10, 2 );

		// One-time prune of history written before the byte cap existed. Without
		// it the cap only governs NEW revisions and existing sites keep whatever
		// they already accumulated (150 MB of postmeta on one measured install).
		add_action( 'admin_init', array( $this, '_action_migrate_revision_budget' ) );

		// --- Edit-mode render filters. ---
		// These act inside the iframe (frame request) AND during the single-item
		// render AJAX (force_edit_render) — the latter happens under admin-ajax,
		// i.e. is_admin() === true — so they are registered unconditionally and
		// gate themselves via is_edit_render().
		//
		// 1. Force wrapper-less leaves (e.g. text-block, which skips its wrapper
		//    unless it has a css_id/class) to always render a wrapper in edit mode,
		//    so every item has an element to stamp. sc_needs_wrapper() only consults
		//    this filter when it would otherwise return false, so styled items are
		//    unaffected.
		add_filter( 'sc_needs_wrapper', array( $this, '_filter_force_wrapper' ), 999 );
		// 2. Stamp each rendered wrapper with its builder unique_id. The item's TYPE
		//    is resolved client-side from the model, so the HTML only needs the id —
		//    no extra DOM, so the column grid / section layout is intact.
		add_filter( 'sc_build_wrapper_attr', array( $this, '_filter_stamp_item_id' ), 999, 2 );
		// View-independent stamping: inject data-fw-item-id into each builder
		// shortcode's OUTPUT. This is the safety net for themes that override the
		// shortcode views (via framework-customizations) with copies that don't call
		// sc_build_wrapper_attr — the filter above never fires for those, but this one
		// stamps the rendered HTML regardless of which view produced it.
		add_filter( 'do_shortcode_tag', array( $this, '_filter_stamp_shortcode_output' ), 10, 4 );

		if ( ! is_admin() ) {
			add_filter( 'template_include', array( $this, '_filter_template_include' ), 999 );
			add_action( 'wp_enqueue_scripts', array( $this, '_action_enqueue_assets' ) );
			add_filter( 'body_class', array( $this, '_filter_body_class' ) );
			// Suppress the WP admin bar inside both the shell and the iframe — the
			// editor provides its own toolbar and the bar only adds clutter / height.
			add_filter( 'show_admin_bar', array( $this, '_filter_show_admin_bar' ), 99 );
			// Diagnostics — only when the editor was opened with ?fw-le-debug (the flag
			// is propagated onto the frame URL by get_frame_url()). This keeps the debug
			// HUD's server-side probe available on demand without any per-load overhead
			// on a normal canvas render (the file_get_contents / reflection it does are
			// not free). The client HUD (Ctrl+Alt+D, Flush OpCache, Test render) stays
			// available regardless.
			if ( FW_Request::GET( 'fw-le-debug' ) ) {
				add_filter( 'the_content', array( $this, '_probe_the_content' ), -9999 );
				add_filter( 'the_content', array( $this, '_probe_the_content_late' ), 99 );
				add_action( 'wp_footer', array( $this, '_action_frame_server_diag' ), 99999 );
			}
		}
	}

	/** @var int diagnostics — times the stamp filter added an id this request */
	private $stamp_count = 0;
	/** @var int diagnostics — total times sc_build_wrapper_attr ran this request */
	private $wrapper_attr_calls = 0;
	/** @var int diagnostics — of those, how many saw is_edit_render()===true */
	private $wrapper_attr_edit_calls = 0;
	/** @var int diagnostics — times the wrapper was force-enabled in edit render */
	private $force_wrapper_count = 0;
	/** @var int diagnostics — times the_content ran while in the editor canvas */
	private $the_content_runs = 0;
	/** @var int diagnostics — total raw length the_content received in the canvas */
	private $the_content_len = 0;
	/** @var int diagnostics — length of the largest the_content blob seen */
	private $the_content_max_len = 0;
	/** @var string diagnostics — head of the largest the_content blob (shortcodes vs HTML) */
	private $the_content_sample = '';
	/** @var bool diagnostics — did [section …] survive past do_shortcode (i.e. NOT consumed)? */
	private $the_content_sc_survived = false;
	/** @var string diagnostics — head of the content AFTER do_shortcode (what it produced) */
	private $the_content_late_sample = '';

	/**
	 * Runs after do_shortcode (priority 11). If "[section" is still present here,
	 * do_shortcode did NOT consume the shortcodes (they aren't registered / were
	 * removed). If it's gone but nothing stamped, the shortcodes rendered through
	 * OLD views that don't call sc_build_wrapper_attr.
	 *
	 * @param string $content
	 *
	 * @return string
	 * @internal
	 */
	public function _probe_the_content_late( $content ) {
		if ( $this->is_frame_request() && strlen( (string) $content ) > 1000 ) {
			$this->the_content_sc_survived = ( strpos( (string) $content, '[section' ) !== false );
			$this->the_content_late_sample = substr( ltrim( (string) $content ), 0, 200 );
		}
		return $content;
	}

	/**
	 * @param string $content
	 *
	 * @return string
	 * @internal
	 */
	public function _probe_the_content( $content ) {
		if ( $this->is_frame_request() ) {
			$this->the_content_runs++;
			$len = strlen( (string) $content );
			$this->the_content_len += $len;
			// Fingerprint the main (largest) blob so we can see whether the canvas got
			// live "[section …]" shortcodes (stamps will follow) or pre-expanded HTML.
			if ( $len > $this->the_content_max_len ) {
				$this->the_content_max_len = $len;
				$this->the_content_sample  = substr( ltrim( (string) $content ), 0, 200 );
			}
		}
		return $content;
	}

	/**
	 * Print the server-side render facts the debug HUD surfaces. Only in the canvas
	 * frame. Lets us see whether the edit-render path actually ran server-side:
	 *  - stamped > 0 but DOM has 0  → an HTML optimizer stripped data-* after render
	 *  - stamped == 0, the_content ran → content bypassed sc_build_wrapper_attr
	 *    (e.g. cached/pre-rendered shortcode HTML), so the filter never fired
	 *  - the_content_runs == 0 → the theme template didn't render the_content here
	 *
	 * @internal
	 */
	public function _action_frame_server_diag() {
		if ( ! $this->is_frame_request() ) {
			return;
		}

		// builder_active gates whether the_posts swaps in live shortcodes (stampable)
		// vs. the pre-rendered post_content (no shortcodes). The decisive extra fact.
		$qpost          = get_queried_object();
		$builder_data   = ( $qpost instanceof WP_Post ) ? fw_get_db_post_option( $qpost->ID, $this->pb()->get_option_key() ) : null;
		$builder_active = is_array( $builder_data ) ? (bool) ( $builder_data['builder_active'] ?? false ) : null;
		$has_json       = is_array( $builder_data ) && ! empty( $builder_data['json'] );

		$sc_ext = fw_ext( 'shortcodes' );
		$pb_ext = fw_ext( 'page-builder' );

		// Where is the ACTIVE shortcodes extension actually loaded from? If a second
		// Unyson (e.g. theme-bundled) is winning, this path won't be our plugin dir,
		// and the [section] callback renders that other copy's (old) view.
		$sc_path = null;
		if ( $sc_ext && method_exists( $sc_ext, 'get_declared_path' ) ) {
			$sc_path = $sc_ext->get_declared_path();
		}
		// Resolve the real file the [section] shortcode renders — the definitive proof
		// of which copy executes.
		$section_view = null;
		if ( $sc_ext && method_exists( $sc_ext, 'get_shortcodes' ) ) {
			$scs = $sc_ext->get_shortcodes();
			if ( isset( $scs['section'] ) && method_exists( $scs['section'], 'locate_path' ) ) {
				$section_view = $scs['section']->locate_path( '/views/view.php' );
			}
		}

		// Stamps produced by the ACTUAL page render (capture before the probe below).
		$render_stamped = (int) $this->stamp_count;

		// Non-destructive direct test: is our stamp filter registered, and does the
		// deployed sc_build_wrapper_attr actually run it? sc_build_wrapper_attr is a
		// pure array-builder (no side effects), and our filter just appends an attr.
		// probeFired=false while stampHooked=true ⇒ the deployed helper is OLDER than
		// its version claims (missing the apply_filters('sc_build_wrapper_attr') call).
		// Raw call counts during the ACTUAL render (capture before the probe below):
		//  wrapperCalls = times sc_build_wrapper_attr ran at all this request.
		//  wrapperEditCalls = of those, how many saw is_edit_render()===true.
		// wrapperCalls==0 with content present ⇒ shortcode output is CACHED (views
		// didn't re-execute). wrapperCalls>0 but editCalls==0 ⇒ is_edit_render was
		// false during render (memoization/timing). editCalls>0 but stamped==0 ⇒
		// unique_id missing from the atts passed to the helper.
		$render_calls      = (int) $this->wrapper_attr_calls;
		$render_edit_calls = (int) $this->wrapper_attr_edit_calls;

		$stamp_hooked = false !== has_filter( 'sc_build_wrapper_attr', array( $this, '_filter_stamp_item_id' ) );
		$probe_before = $this->stamp_count;
		if ( function_exists( 'sc_build_wrapper_attr' ) ) {
			sc_build_wrapper_attr( array( 'unique_id' => 'fw-le-probe', 'base_class' => 'fw-le-probe' ) );
		}
		$probe_fired = ( $this->stamp_count > $probe_before );

		echo "\n<script>window._fwLeServerDiag=" . wp_json_encode( array(
			'isFrameRequest'  => true,
			'editRender'      => (bool) $this->is_edit_render(),
			'stampHooked'     => $stamp_hooked,
			'probeFired'      => $probe_fired,
			'stamped'         => $render_stamped,
			'wrapperCalls'    => $render_calls,
			'wrapperEditCalls'=> $render_edit_calls,
			'forcedWrappers'  => (int) $this->force_wrapper_count,
			'theContentRuns'  => (int) $this->the_content_runs,
			'theContentLen'   => (int) $this->the_content_len,
			'theContentSample'=> $this->the_content_sample,
			'theContentLate'  => $this->the_content_late_sample,
			'scSurvived'      => (bool) $this->the_content_sc_survived,
			'builderActive'   => $builder_active,
			'hasBuilderJson'  => $has_json,
			// Version / capability of the code the stamping depends on. If the helpers
			// are missing or the extensions are old, the views won't stamp.
			'shortcodesVer'   => $sc_ext ? $sc_ext->manifest->get_version() : null,
			'pageBuilderVer'  => $pb_ext ? $pb_ext->manifest->get_version() : null,
			'helperWrapper'   => function_exists( 'sc_build_wrapper_attr' ),
			'helperNeeds'     => function_exists( 'sc_needs_wrapper' ),
			'scSection'       => shortcode_exists( 'section' ),
			'scTextBlock'     => shortcode_exists( 'text_block' ),
			'theme'           => get_stylesheet(),
			'template'        => get_page_template_slug() ?: basename( (string) get_page_template() ),
			// OpCache: validate_timestamps=0 (common on WP Engine) ⇒ updated PHP files
			// run STALE bytecode until OpCache is flushed. The decisive environment fact.
			'opcacheEnabled'  => function_exists( 'opcache_get_status' ) && (bool) @ini_get( 'opcache.enable' ),
			'opcacheValidate' => (string) @ini_get( 'opcache.validate_timestamps' ),
			'opcacheFreq'     => (string) @ini_get( 'opcache.revalidate_freq' ),
			'opcacheCanReset' => function_exists( 'opcache_reset' ),
			'shortcodesPath'  => $sc_path,
			'sectionView'     => $section_view,
			// Does the file the section shortcode renders contain the current marker?
			'sectionViewIsCurrent' => ( $section_view && is_readable( $section_view ) )
				? ( strpos( (string) file_get_contents( $section_view ), 'sc_build_wrapper_attr' ) !== false )
				: null,
		) ) . ";</script>\n";
	}

	/**
	 * Edit-render mode = either we're rendering the live canvas (inside the
	 * iframe) or we're rendering a single item for the re-render AJAX.
	 *
	 * @return bool
	 */
	private function is_edit_render() {
		return $this->force_edit_render || $this->is_frame_request();
	}

	/** @var bool set true around the single-item render AJAX */
	private $force_edit_render = false;

	/**
	 * @param bool $needs
	 *
	 * @return bool
	 * @internal
	 */
	public function _filter_force_wrapper( $needs ) {
		if ( $this->is_edit_render() ) {
			$this->force_wrapper_count++;
			return true;
		}
		return $needs;
	}

	/**
	 * @param array $attr  wrapper HTML attributes being assembled
	 * @param array $atts  the shortcode/item attributes (carry unique_id)
	 *
	 * @return array
	 * @internal
	 */
	public function _filter_stamp_item_id( $attr, $atts ) {
		$this->wrapper_attr_calls++;

		if ( ! $this->is_edit_render() ) {
			return $attr;
		}

		$this->wrapper_attr_edit_calls++;

		if ( ! empty( $atts['unique_id'] ) ) {
			$attr['data-fw-item-id'] = $atts['unique_id'];
			$this->stamp_count++;
		}

		// Visibility is driven by the responsive_hide option (the "Hide on"
		// checkboxes), whose hide-xs/hide-sm/hide-md classes the frontend CSS
		// turns into display:none per breakpoint. In the editor canvas we must
		// NOT actually hide the element — it has to stay visible + selectable so
		// it can be un-hidden — so strip those classes here. The Live Editor reads
		// responsive_hide from the model and dims the item client-side instead.
		if ( ! empty( $attr['class'] ) ) {
			$attr['class'] = trim( preg_replace(
				'/\b(?:hide-xs|hide-sm|hide-md)\b/',
				'',
				(string) $attr['class']
			) );
			$attr['class'] = preg_replace( '/\s+/', ' ', $attr['class'] );
		}

		return $attr;
	}

	/**
	 * View-independent stamping. Runs on `do_shortcode_tag` (the output of every
	 * shortcode) and injects `data-fw-item-id` into the first opening tag of a
	 * builder item's rendered HTML — so the Live Editor can select it even when the
	 * shortcode view was overridden by the theme (framework-customizations) with a
	 * copy that never calls sc_build_wrapper_attr.
	 *
	 * Nesting-safe: the "already stamped" guard inspects only the FIRST tag, so a
	 * section whose own wrapper is unstamped still gets stamped even though its inner
	 * (already-stamped) items appear deeper in the output. Skips when the wrapper was
	 * already stamped by the sc_build_wrapper_attr path (plugin views), avoiding
	 * duplicates.
	 *
	 * @param string $output Shortcode output HTML.
	 * @param string $tag    Shortcode tag.
	 * @param array|string $attr Shortcode attributes.
	 * @param array  $m      Regex match.
	 *
	 * @return string
	 * @internal
	 */
	public function _filter_stamp_shortcode_output( $output, $tag, $attr, $m ) {
		if ( ! $this->is_edit_render() || ! is_string( $output ) || $output === '' ) {
			return $output;
		}

		$uid = ( is_array( $attr ) && ! empty( $attr['unique_id'] ) ) ? (string) $attr['unique_id'] : '';
		if ( $uid === '' ) {
			return $output;
		}

		// Already stamped by the view? The first opening tag would carry it.
		if ( preg_match( '/^\s*<[a-zA-Z][^>]*\bdata-fw-item-id=/', $output ) ) {
			return $output;
		}

		$stamped = preg_replace(
			'/<([a-zA-Z][a-zA-Z0-9-]*)/',
			'<$1 data-fw-item-id="' . esc_attr( $uid ) . '"',
			$output,
			1
		);

		if ( is_string( $stamped ) && $stamped !== $output ) {
			$this->stamp_count++;
			// Strip the responsive_hide breakpoint classes from that same first tag so
			// the item stays visible/selectable in the canvas (mirrors the wrapper-attr
			// path). Only touch the first tag's class attribute.
			$stamped = preg_replace_callback(
				'/^(\s*<[a-zA-Z][a-zA-Z0-9-]*[^>]*\bclass=")([^"]*)(")/',
				function ( $mm ) {
					$cls = trim( preg_replace( '/\b(?:hide-xs|hide-sm|hide-md)\b/', '', $mm[2] ) );
					$cls = preg_replace( '/\s+/', ' ', $cls );
					return $mm[1] . $cls . $mm[3];
				},
				$stamped,
				1
			);
			return $stamped;
		}

		return $output;
	}

	/**
	 * The Page Builder extension (owns is_builder_post() + the option key). This
	 * is a top-level extension that hard-requires page-builder, so the lookup is
	 * always satisfied by the time any of our hooks run.
	 *
	 * @return FW_Extension_Page_Builder
	 */
	private function pb() {
		return fw_ext( 'page-builder' );
	}

	/* ---------------------------------------------------------------------
	 * Request detection
	 * ------------------------------------------------------------------- */

	/**
	 * Is the current request the editor SHELL (the chrome we render instead of
	 * the theme template)? True only for a singular, builder-enabled post the
	 * current user may edit, requested with the boot query var.
	 *
	 * @return bool
	 */
	private function is_boot_request() {
		return $this->request_targets_editable_builder_post( $this->boot_query_var );
	}

	/**
	 * Is the current request the document rendered INSIDE the iframe (the live
	 * canvas)? Same guards as the shell, but keyed on the frame query var.
	 *
	 * Memoized: the stamping filters call this once per rendered shortcode, and
	 * the underlying is_builder_post() check hits the DB — so resolve it once the
	 * main query is available, then reuse.
	 *
	 * @return bool
	 */
	private function is_frame_request() {
		if ( null !== $this->frame_mode_cache ) {
			return $this->frame_mode_cache;
		}

		// Don't cache a premature "false" before the main query has run.
		if ( ! did_action( 'wp' ) ) {
			return false;
		}

		return $this->frame_mode_cache = $this->request_targets_editable_builder_post( $this->frame_query_var );
	}

	/** @var bool|null memoized result of is_frame_request() */
	private $frame_mode_cache = null;

	/**
	 * @param string $query_var
	 *
	 * @return bool
	 */
	private function request_targets_editable_builder_post( $query_var ) {
		if ( is_admin() ) {
			return false;
		}

		if ( ! FW_Request::GET( $query_var ) ) {
			return false;
		}

		// These conditionals are only meaningful once the main query has run.
		if ( ! did_action( 'wp' ) || ! is_singular() ) {
			return false;
		}

		$post = get_queried_object();

		return $post instanceof WP_Post
			&& current_user_can( 'edit_post', $post->ID )
			&& $this->pb()->is_builder_post( $post->ID );
	}

	/* ---------------------------------------------------------------------
	 * Admin-bar "Edit Live" button
	 * ------------------------------------------------------------------- */

	/**
	 * @param WP_Admin_Bar $wp_admin_bar
	 *
	 * @internal
	 */
	public function _action_admin_bar_menu( $wp_admin_bar ) {
		// Don't offer the button when we're already inside the editor.
		if ( $this->is_boot_request() || $this->is_frame_request() ) {
			return;
		}

		$post = $this->get_admin_bar_target_post();

		if ( ! $post ) {
			return;
		}

		// Brand the entry with the UnysonPlus mark (the same white U+ logo shown in
		// the editor toolbar) instead of the generic pencil dashicon, so it reads as
		// our tool rather than a stock WP edit link.
		$logo = esc_url( $this->get_declared_URI( '/static/img/unysonplus-logo.png' ) );
		// display:inline-block !important keeps the icon inline with the label even when the
		// active (child) theme ships a global `img { display:block }` reset — otherwise a block
		// image drops onto its own line and wraps "Edit Live" to a second row in the 32px bar.
		$icon = '<img src="' . $logo . '" alt="" aria-hidden="true" '
		      . 'style="display:inline-block !important;height:16px;width:auto;vertical-align:middle;margin:0 6px 0 2px;position:relative;top:-1px;" />';

		$wp_admin_bar->add_node( array(
			'id'    => 'fw-live-editor',
			'title' => $icon . esc_html__( 'Edit Live', 'fw' ),
			'href'  => $this->get_boot_url( $post ),
			'meta'  => array(
				'title' => esc_attr__( 'Edit this page with the Live Page Editor', 'fw' ),
			),
		) );
	}

	/**
	 * Resolve the builder post the admin-bar button should target: the queried
	 * object on the front-end, or the post being edited in wp-admin. Returns null
	 * (no button) unless it's a builder post the user can edit.
	 *
	 * @return WP_Post|null
	 */
	private function get_admin_bar_target_post() {
		$post = null;

		if ( is_admin() ) {
			$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;

			if ( $screen && 'post' === $screen->base ) {
				$post = get_post();
			}
		} elseif ( did_action( 'wp' ) && is_singular() ) {
			$post = get_queried_object();
		}

		if ( ! $post instanceof WP_Post ) {
			return null;
		}

		if ( ! current_user_can( 'edit_post', $post->ID ) ) {
			return null;
		}

		if ( ! $this->pb()->is_builder_post( $post->ID ) ) {
			return null;
		}

		return $post;
	}

	/**
	 * Is this a builder post the current user may open in the live editor? Shared
	 * gate for the Publish-box button + the list-table row action.
	 *
	 * @param WP_Post|int $post
	 *
	 * @return bool
	 */
	private function can_edit_live( $post ) {
		$post = get_post( $post );

		return $post instanceof WP_Post
			&& 'auto-draft' !== $post->post_status
			&& 'trash' !== $post->post_status
			&& current_user_can( 'edit_post', $post->ID )
			&& $this->pb()
			&& $this->pb()->is_builder_post( $post->ID );
	}

	/**
	 * "Edit on Live Editor" button in the Publish/Update meta box.
	 *
	 * @internal
	 */
	public function _action_submitbox_edit_live() {
		$post = get_post();

		if ( ! $this->can_edit_live( $post ) ) {
			return;
		}

		echo '<div class="misc-pub-section" style="text-align:center;">'
			. '<a href="' . esc_url( $this->get_boot_url( $post ) ) . '" class="button button-secondary" style="width:100%;box-sizing:border-box;">'
			. '<span class="dashicons dashicons-edit" style="vertical-align:text-top;"></span> '
			. esc_html__( 'Edit on Live Editor', 'fw' )
			. '</a></div>';
	}

	/**
	 * "Edit with Unyson+ Live Editor" hover action in the Pages/Posts list table.
	 *
	 * @param string[] $actions
	 * @param WP_Post   $post
	 *
	 * @return string[]
	 * @internal
	 */
	public function _filter_row_actions( $actions, $post ) {
		if ( $this->can_edit_live( $post ) ) {
			$actions['fw_live_editor'] = '<a href="' . esc_url( $this->get_boot_url( $post ) ) . '">'
				. esc_html__( 'Edit with Unyson+ Live Editor', 'fw' )
				. '</a>';
		}

		return $actions;
	}

	/* ---------------------------------------------------------------------
	 * URLs
	 * ------------------------------------------------------------------- */

	/**
	 * The URL that opens the editor shell for a post.
	 *
	 * @param WP_Post $post
	 *
	 * @return string
	 */
	private function get_boot_url( WP_Post $post ) {
		return add_query_arg( $this->boot_query_var, 1, get_permalink( $post->ID ) );
	}

	/**
	 * The URL loaded inside the iframe (the live canvas). Carries ONLY the frame
	 * var — never the boot var — so the page can't recursively re-open the shell.
	 * Propagates ?fw-le-debug so the frame request also enables the server-side
	 * diagnostics (they're gated on that flag in _init).
	 *
	 * @param WP_Post $post
	 *
	 * @return string
	 */
	public function get_frame_url( WP_Post $post ) {
		$url = add_query_arg( $this->frame_query_var, 1, get_permalink( $post->ID ) );
		if ( FW_Request::GET( 'fw-le-debug' ) ) {
			$url = add_query_arg( 'fw-le-debug', 1, $url );
		}
		return $url;
	}

	/* ---------------------------------------------------------------------
	 * Template routing — render the shell instead of the theme template
	 * ------------------------------------------------------------------- */

	/**
	 * @param string $template
	 *
	 * @return string
	 * @internal
	 */
	public function _filter_template_include( $template ) {
		if ( ! $this->is_boot_request() ) {
			return $template; // frame request + everything else render normally
		}

		return dirname( __FILE__ ) . '/views/editor-shell.php';
	}

	/* ---------------------------------------------------------------------
	 * Assets
	 * ------------------------------------------------------------------- */

	/**
	 * @internal
	 */
	public function _action_enqueue_assets() {
		if ( $this->is_boot_request() ) {
			$this->enqueue_shell_assets();
		} elseif ( $this->is_frame_request() ) {
			$this->enqueue_frame_assets();
		}
	}

	/**
	 * Cache-busting asset version: the manifest version PLUS the file's mtime.
	 * The mtime advances on every deploy even when the framework's manifest
	 * version is being served from a stale persistent object cache (as on hosts
	 * with Memcached), so a changed asset always gets a fresh URL and can never
	 * stick behind a CDN/browser cache. Falls back to the bare version if the
	 * file can't be stat'd.
	 */
	private function asset_ver( $rel_path ) {
		$ver = $this->manifest->get_version();
		$mt  = @filemtime( $this->get_declared_path( $rel_path ) );
		return $mt ? ( $ver . '.' . $mt ) : $ver;
	}

	/**
	 * Assets for the editor chrome (the shell document around the iframe).
	 */
	private function enqueue_shell_assets() {
		$post = get_queried_object();

		// Bring the framework's options-editing runtime (fw.OptionsModal + every
		// option-type's JS/CSS) onto this front-end editor shell. The backend
		// component registers/enqueues that runtime only during admin_enqueue_scripts;
		// this shell is a dedicated editor document we render in place of the theme
		// and fully own, so we satisfy that one timing guard, then reuse the exact
		// same loader the page-builder uses on the post-edit screen.
		$this->enqueue_options_runtime();

		// Some option types print their JS <script type="text/html"> templates
		// (e.g. the icon picker's #tmpl-fw-icon-v2-*) on the admin-only
		// `admin_print_footer_scripts` hook, which never fires on the front end —
		// so their modal controls render blank. Bridge that hook to wp_footer so
		// those templates are emitted into the shell.
		add_action( 'wp_footer', function () { do_action( 'admin_print_footer_scripts' ); }, 9 );

		// Deliberately do NOT depend on the framework options runtime here: if any
		// runtime handle failed to load, WordPress would drop a dependent script,
		// taking the editor's connect/selection logic down with it. The shell only
		// needs jQuery + dashicons; fw.OptionsModal is loaded separately (below) and
		// checked lazily when the user actually opens an item to edit.
		wp_enqueue_style(
			'fw-live-editor',
			fw_min_uri( $this->get_declared_URI( '/static/css/live-editor.css' ) ),
			array( 'dashicons' ),
			$this->asset_ver( '/static/css/live-editor.css' )
		);

		wp_enqueue_script(
			'fw-live-editor',
			fw_min_uri( $this->get_declared_URI( '/static/js/live-editor.js' ) ),
			array( 'jquery' ),
			$this->asset_ver( '/static/js/live-editor.js' ),
			true
		);

		$builder_data = fw_get_db_post_option( $post->ID, $this->pb()->get_option_key() );

		wp_localize_script( 'fw-live-editor', '_fwLiveEditor', array(
			'postId'   => (int) $post->ID,
			'version'  => $this->manifest->get_version(),
			// Auto-open the diagnostics HUD when the boot URL carries ?fw-le-debug.
			'debug'    => (bool) FW_Request::GET( 'fw-le-debug' ),
			'frameUrl' => $this->get_frame_url( $post ),
			'exitUrl'  => get_permalink( $post->ID ),
			'editUrl'  => admin_url( 'post.php?post=' . (int) $post->ID . '&action=edit' ),
			'ajaxUrl'  => admin_url( 'admin-ajax.php' ),
			'nonce'    => wp_create_nonce( 'fw-live-editor:' . $post->ID ),
			'actions'  => array(
				'itemOptions' => 'fw_live_editor_item_options',
				'renderItem'  => 'fw_live_editor_render_item',
				'newItem'     => 'fw_live_editor_new_item',
				'newSection'  => 'fw_live_editor_new_section',
				'newColumn'   => 'fw_live_editor_new_column',
				'newContainer' => 'fw_live_editor_new_container',
				'renderPage'  => 'fw_live_editor_render_page',
				'save'        => 'fw_live_editor_save',
				'autosave'    => 'fw_live_editor_autosave',
				'revisions'    => 'fw_live_editor_revisions',
				'revisionGet'  => 'fw_live_editor_revision_get',
				'opcacheFlush' => 'fw_live_editor_opcache_flush',
			),
			// Insertable leaf elements for the "Add" panel (drag onto the canvas).
			'elements' => $this->get_insertable_elements(),
			// Section types available for the structure picker (only those whose
			// shortcode is actually registered).
			'sectionTypes' => $this->get_section_types(),
			// Server-side diagnostic: did WordPress actually enqueue the options
			// runtime on this shell? If these are false, the core
			// `fw:backend:enqueue-options-on-frontend` filter isn't taking effect
			// (e.g. a stale cached backend.php), so the modal can't load.
			'runtime'  => array(
				'fw'             => wp_script_is( 'fw', 'enqueued' ),
				'backendOptions' => wp_script_is( 'fw-backend-options', 'enqueued' ),
				'filterCanLoad'  => (bool) apply_filters( 'fw:backend:enqueue-options-on-frontend', false ),
			),
			// The single source of truth: the same builder JSON the classic
			// backend builder stores. Later phases edit this in place and save
			// it back to the page-builder post option.
			'builder'  => array(
				'json' => isset( $builder_data['json'] ) ? $builder_data['json'] : '[]',
			),
			// Background recovery autosave: how often to back up, plus any pending
			// autosave that's NEWER than the last real save (offer to restore it).
			'autosaveInterval' => 15000,
			'autosave' => $this->get_pending_autosave( $post ),
			// Builder Templates (full / section / column). The shell drives the
			// framework's standard `fw_builder_templates_*` admin-ajax handlers
			// directly — they self-register on any admin-ajax request — so all we
			// need to ship is the builder type + the nonces those handlers check.
			// Gate on the page-builder extension being active (a hard requirement
			// of this extension anyway): the FW_Ext_Builder_Templates class only
			// autoloads when the page-builder option type initializes, which does
			// NOT happen on this front-end shell — so class_exists() is the wrong
			// test here. The AJAX endpoints still register fine on admin-ajax.
			'templates' => array(
				'enabled'     => (bool) fw_ext( 'page-builder' ),
				'builderType' => 'page-builder',
				'nonces'      => array(
					'render'  => wp_create_nonce( 'fw_builder_templates' ),
					'full'    => wp_create_nonce( 'fw_builder_templates_full' ),
					'section' => wp_create_nonce( 'fw_builder_templates_section' ),
					'column'  => wp_create_nonce( 'fw_builder_templates_column' ),
				),
			),
			'l10n'     => array(
				'title'       => __( 'Live Editor', 'fw' ),
				'save'        => __( 'Save', 'fw' ),
				'exit'        => __( 'Exit', 'fw' ),
				'connecting'  => __( 'Connecting…', 'fw' ),
				'ready'       => __( 'Ready', 'fw' ),
				'unsaved'     => __( 'Unsaved changes', 'fw' ),
				'saving'      => __( 'Saving…', 'fw' ),
				'saved'       => __( 'Saved', 'fw' ),
				'saveError'   => __( 'Save failed', 'fw' ),
				'confirmExit' => __( 'You have unsaved changes. Leave anyway?', 'fw' ),
				'add'         => __( 'Add', 'fw' ),
				'addElement'  => __( 'Add Element', 'fw' ),
				'search'      => __( 'Search…', 'fw' ),
				'addSection'  => __( 'Section', 'fw' ),
				'structure'   => __( 'Choose a structure', 'fw' ),
				'sectionType' => __( 'Section type', 'fw' ),
				'addColumn'   => __( 'Add Column', 'fw' ),
				'firstSection' => __( 'Add your first section', 'fw' ),
				'addSectionHere' => __( 'Add Section', 'fw' ),
				'selectImage'  => __( 'Select Image', 'fw' ),
				'useImage'     => __( 'Use this image', 'fw' ),
				'navigator'    => __( 'Structure', 'fw' ),
				'noSections'   => __( 'No sections yet.', 'fw' ),
				'renameTip'    => __( 'Double-click to rename', 'fw' ),
				'templates'         => __( 'Templates', 'fw' ),
				'templatesLoading'  => __( 'Loading templates…', 'fw' ),
				'templatesError'    => __( 'Could not load templates.', 'fw' ),
				'saveSection'       => __( 'Save current section as Template', 'fw' ),
				'saveColumn'        => __( 'Save current column as Template', 'fw' ),
				'templateName'      => __( 'Template Name', 'fw' ),
				'saveTemplateTitle' => __( 'Save Template', 'fw' ),
				'replacePageTitle'  => __( 'Replace page with this template?', 'fw' ),
				'replacePageMsg'    => __( 'This swaps the entire page for the full template. You can Exit without saving (or Undo) to revert.', 'fw' ),
				'replacePageOk'     => __( 'Replace', 'fw' ),
				'deleteTemplateTitle' => __( 'Delete this template?', 'fw' ),
				'deleteTemplateMsg'   => __( 'This permanently removes the saved template.', 'fw' ),
				'noSectionSelected'   => __( 'Select a section first (click one on the page), then save it as a template.', 'fw' ),
				'noColumnSelected'    => __( 'Select a column first (click one on the page), then save it as a template.', 'fw' ),
				'noSectionTarget'     => __( 'Add or select a section first — a column template needs a section to drop into.', 'fw' ),
				'importFailed'        => __( 'Failed to import template', 'fw' ),
				'copied'              => __( 'Copied', 'fw' ),
				'clipboardEmpty'      => __( 'Nothing to paste — copy an element first.', 'fw' ),
				'pasteNeedColumn'     => __( 'Select a column or element to paste into.', 'fw' ),
				'pasteNeedSection'    => __( 'Add or select a section first.', 'fw' ),
				'settingsCopied'      => __( 'Settings copied', 'fw' ),
				'noSettings'          => __( 'No settings copied yet — use "Copy Settings" first.', 'fw' ),
				'noSettingsApplied'   => __( 'None of the copied settings apply to this element.', 'fw' ),
				'restoreTitle'        => __( 'Restore unsaved changes?', 'fw' ),
				'restoreMsg'          => __( 'We found autosaved changes from %s. Restore them, or discard and keep the last saved version?', 'fw' ),
				'restore'             => __( 'Restore', 'fw' ),
				'discard'             => __( 'Discard', 'fw' ),
				'autoSaved'           => __( 'Auto Saved', 'fw' ),
				'history'             => __( 'History', 'fw' ),
				'revisionsTitle'      => __( 'Revision History', 'fw' ),
				'noRevisions'         => __( 'No saved versions yet. Revisions are created each time you Save.', 'fw' ),
				'current'             => __( 'Current', 'fw' ),
				'restoreRevTitle'     => __( 'Restore this version?', 'fw' ),
				'restoreRevMsg'       => __( 'This replaces the current content with the selected version. You can undo (Ctrl+Z), or Save to keep it.', 'fw' ),
				'revisionError'       => __( 'Could not load this version.', 'fw' ),
			),
		) );
	}

	/**
	 * Load the backend options runtime + every shortcode option-type's static
	 * assets onto the shell.
	 *
	 * The framework's backend component registers its options runtime (fw /
	 * fw.OptionsModal / fw-backend-options / the reactive-option scripts) only in
	 * wp-admin. We opt this single front-end request in via the framework's
	 * `fw:backend:enqueue-options-on-frontend` filter, then reuse the framework's
	 * own loader — so the exact set of handles always matches the installed
	 * framework version (no hand-maintained copy to drift out of date).
	 */
	private function enqueue_options_runtime() {
		// Tell the framework to register/enqueue its backend options runtime on
		// this front-end request (only honored during wp_enqueue_scripts).
		add_filter( 'fw:backend:enqueue-options-on-frontend', '__return_true' );

		// CRITICAL: the framework runtime hard-depends on WordPress *core admin*
		// script handles that aren't registered on the front end of this site
		// (verified: postbox / wp-color-picker / iris all unregistered). When a
		// script has an unregistered dependency, WordPress silently refuses to
		// print the WHOLE dependent chain — so fw-backend-options → fw →
		// fw.OptionsModal never reach the page. Register the missing core handles
		// (from their core paths) BEFORE the framework loader enqueues anything,
		// so the dependency chain resolves and `fw` is actually emitted.
		$this->ensure_core_script( 'jquery-touch-punch', 'js/jquery/jquery.ui.touch-punch.js' );
		$this->ensure_core_script( 'iris', 'js/iris.min.js', array( 'jquery-ui-draggable', 'jquery-ui-slider', 'jquery-touch-punch' ) );
		$this->ensure_core_script( 'wp-color-picker', 'js/color-picker.min.js', array( 'iris', 'wp-i18n' ) );
		$this->ensure_core_script( 'postbox', 'js/postbox.min.js', array( 'jquery-ui-sortable', 'wp-a11y' ) );
		if ( ! wp_style_is( 'wp-color-picker', 'registered' ) ) {
			wp_register_style( 'wp-color-picker', admin_url( 'css/color-picker.min.css' ), array(), false );
		}

		$this->load_shortcodes();

		// Same loader the page-builder uses on the post-edit screen: enqueues the
		// base runtime + every shortcode option-type's static assets.
		if ( function_exists( 'fw_ext_shortcodes_enqueue_shortcodes_admin_scripts' ) ) {
			fw_ext_shortcodes_enqueue_shortcodes_admin_scripts();
		}

		// Define `fw.shortcodesLoadData` / `fw.unysonShortcodesData` right after
		// fw.js. The wp-shortcodes TinyMCE plugin (pulled in by wp_enqueue_editor)
		// and a few form-builder item scripts call these at load, but they're only
		// registered in wp-admin — so on the front-end shell they throw
		// "fw.shortcodesLoadData is not a function". An inline 'after' fw guarantees
		// they exist before those footer scripts run (enqueuing the source script
		// separately doesn't, since load order between footer siblings isn't fixed).
		wp_add_inline_script(
			'fw',
			'if (window.fw && typeof fw.shortcodesLoadData !== "function") {'
			. 'fw.shortcodesLoadData = (function ($) { var p = null; return function (f) { if (f) { p = null; } if (p) { return p; } p = $.post(window.ajaxurl, { action: "fw_ext_wp_shortcodes_data" }); return p; }; })(jQuery);'
			. 'fw.unysonShortcodesData = function (f) { var p = fw.shortcodesLoadData(f); if (p.state() === "resolved" && p.responseJSON && p.responseJSON.success) { return p.responseJSON.data; } return null; };'
			. '}',
			'after'
		);

		// The wp-shortcodes TinyMCE plugin (the "Unyson Shortcodes" editor button)
		// reads `fw_ext_wp_shortcodes_localizations`, localized only in wp-admin —
		// without it the plugin throws "… is not defined" and fails to init. Provide
		// it on the shell so the editor's shortcodes button works.
		$wp_sc = fw_ext( 'wp-shortcodes' );
		if ( $wp_sc && method_exists( $wp_sc, 'default_shortcodes_list' ) ) {
			wp_localize_script(
				'fw',
				'fw_ext_wp_shortcodes_localizations',
				array(
					'button_title'            => __( 'Unyson Shortcodes', 'fw' ),
					'default_shortcodes_list' => $wp_sc->default_shortcodes_list(),
				)
			);
			// The plugin's CSS (button icon + the shortcode-picker grid window) is
			// also admin-only — without it the button shows no icon and the picker
			// renders as a tall, unstyled list.
			if ( method_exists( $wp_sc, 'locate_css_URI' ) ) {
				wp_enqueue_style(
					'fw-ext-wp-shortcodes-css',
					$wp_sc->locate_css_URI( 'styles' ),
					array(),
					fw()->manifest->get_version()
				);
			}
		}

		wp_enqueue_script( 'postbox' );        // now registered → fw chain prints
		wp_enqueue_script( 'wp-color-picker' );
		wp_enqueue_style( 'wp-color-picker' );

		// The options modal's controls (inputs, buttons, tabs, the editor + media
		// frame) are authored against WordPress admin base CSS, which a front-end
		// page doesn't load. Enqueue those core admin stylesheets so the modal
		// looks like it does in wp-admin. (Registered by core; enqueue if present.)
		foreach ( array( 'common', 'forms', 'buttons', 'dashicons', 'editor-buttons', 'media-views', 'wp-jquery-ui-dialog' ) as $style ) {
			if ( wp_style_is( $style, 'registered' ) ) {
				wp_enqueue_style( $style );
			}
		}

		// The wp-editor option type (e.g. the Text element's Content field) renders
		// a rich editor whose client init calls the global `tinymce`/`quicktags`.
		// Those only exist if WordPress's editor runtime is loaded on the page —
		// which never happens on a normal front end. Enqueue it so Visual mode works.
		if ( function_exists( 'wp_enqueue_editor' ) ) {
			wp_enqueue_editor();
		}

		// The WordPress media library (wp.media) powers the direct image-swap
		// (double-click an image) and any `upload` option field. Ensure it's
		// always present, not just when an option type happens to enqueue it.
		if ( function_exists( 'wp_enqueue_media' ) ) {
			wp_enqueue_media();
		}
	}

	/**
	 * Register a WordPress-core admin script handle if it's missing on the front
	 * end. Dependencies are filtered to those actually registered, so an
	 * unregistered sub-dependency (this site strips several core admin scripts)
	 * can't cause WordPress to drop this handle too.
	 *
	 * @param string $handle
	 * @param string $admin_rel path relative to wp-admin/
	 * @param array  $deps
	 */
	private function ensure_core_script( $handle, $admin_rel, $deps = array() ) {
		if ( wp_script_is( $handle, 'registered' ) ) {
			return;
		}
		$deps = array_values( array_filter( $deps, function ( $d ) {
			return wp_script_is( $d, 'registered' );
		} ) );
		wp_register_script( $handle, admin_url( $admin_rel ), $deps, false, true );
	}

	/**
	 * Ensure the shortcode definitions (and their option types) are loaded —
	 * needed before reading a shortcode's options or rendering an item.
	 */
	private function load_shortcodes() {
		$sc = fw_ext( 'shortcodes' );
		if ( $sc && method_exists( $sc, 'load_shortcodes' ) ) {
			$sc->load_shortcodes();
		}
	}

	/**
	 * The leaf elements a user can drag onto the canvas, grouped data for the
	 * "Add" panel. Built from the shortcodes builder data (the same registry the
	 * classic builder's element list uses). Shortcodes are already loaded by
	 * enqueue_options_runtime() before this runs.
	 *
	 * @return array[] each { tag, title, tab, icon }
	 */
	private function get_insertable_elements() {
		$out = array();
		$sc  = fw_ext( 'shortcodes' );
		if ( ! $sc || ! method_exists( $sc, 'get_shortcodes' ) || ! method_exists( $sc, 'get_shortcode_builder_data' ) ) {
			return $out;
		}

		// Make sure every shortcode is loaded, then build the list PER SHORTCODE.
		// (Using the aggregate get_builder_data() risks a stale partial cache that
		// was populated before all shortcodes finished loading.)
		$this->load_shortcodes();

		foreach ( array_keys( (array) $sc->get_shortcodes() ) as $tag ) {
			$row = $sc->get_shortcode_builder_data( $tag );
			if ( ! is_array( $row ) ) {
				continue; // not a "simple" page-builder element (e.g. section/column/row)
			}
			$out[] = array(
				'tag'   => $tag,
				'title' => isset( $row['title'] ) && $row['title'] !== '' ? $row['title'] : $tag,
				'tab'   => isset( $row['tab'] ) && $row['tab'] !== '~' ? $row['tab'] : __( 'Elements', 'fw' ),
				'icon'  => isset( $row['icon'] ) ? $row['icon'] : '',
			);
		}
		return $out;
	}

	/**
	 * Assets for the document inside the iframe (the live canvas bridge).
	 * Phase 0: just the postMessage handshake + a body hook for edit-mode CSS.
	 * Phase 1 grows this into the selection / outline layer.
	 */
	private function enqueue_frame_assets() {
		wp_enqueue_style(
			'fw-live-editor-frame',
			fw_min_uri( $this->get_declared_URI( '/static/css/live-editor-frame.css' ) ),
			array(),
			$this->asset_ver( '/static/css/live-editor-frame.css' )
		);

		wp_enqueue_script(
			'fw-live-editor-frame',
			fw_min_uri( $this->get_declared_URI( '/static/js/live-editor-frame.js' ) ),
			array( 'jquery' ),
			$this->asset_ver( '/static/js/live-editor-frame.js' ),
			true
		);

		wp_localize_script( 'fw-live-editor-frame', '_fwLiveEditorFrame', array(
			'postId'  => (int) get_queried_object_id(),
			'version' => $this->manifest->get_version(),
			'l10n'   => array(
				'firstSection'   => __( 'Add your first section', 'fw' ),
				'addSectionHere' => __( 'Add Section', 'fw' ),
				'addColumn'      => __( 'Add Column', 'fw' ),
			),
		) );
	}

	/* ---------------------------------------------------------------------
	 * Misc front-end tweaks
	 * ------------------------------------------------------------------- */

	/**
	 * @param string[] $classes
	 *
	 * @return string[]
	 * @internal
	 */
	public function _filter_body_class( $classes ) {
		if ( $this->is_frame_request() ) {
			$classes[] = 'fw-live-editor-frame-active';
		}

		return $classes;
	}

	/**
	 * @param bool $show
	 *
	 * @return bool
	 * @internal
	 */
	public function _filter_show_admin_bar( $show ) {
		if ( $this->is_boot_request() || $this->is_frame_request() ) {
			return false;
		}

		return $show;
	}

	/* ---------------------------------------------------------------------
	 * Phase 2 — AJAX: per-item options + single-item re-render
	 * ------------------------------------------------------------------- */

	/**
	 * Shared guard for the editor AJAX endpoints: a valid nonce + edit_post cap
	 * on the targeted post. Sends a JSON error and exits on failure.
	 *
	 * @return int validated post id
	 */
	private function verify_ajax() {
		$post_id = (int) FW_Request::POST( 'post_id' );
		$nonce   = (string) FW_Request::POST( 'nonce' );

		if (
			! $post_id
			|| ! wp_verify_nonce( $nonce, 'fw-live-editor:' . $post_id )
			|| ! current_user_can( 'edit_post', $post_id )
		) {
			wp_send_json_error( array( 'message' => __( 'Permission denied.', 'fw' ) ), 403 );
		}

		return $post_id;
	}

	/**
	 * Return the option definitions for an item's shortcode, so the shell can
	 * seed fw.OptionsModal. POST: post_id, nonce, tag (shortcode tag — for
	 * containers that's "section"/"column"/a section-like type).
	 *
	 * @internal
	 */
	public function _ajax_item_options() {
		$this->verify_ajax();

		$tag = (string) FW_Request::POST( 'tag' );

		$this->load_shortcodes();

		$shortcodes_ext = fw_ext( 'shortcodes' );
		$shortcode      = $shortcodes_ext ? $shortcodes_ext->get_shortcode( $tag ) : null;

		if ( ! $shortcode ) {
			wp_send_json_error( array( 'message' => sprintf( __( 'Unknown item type: %s', 'fw' ), $tag ) ) );
		}

		// Feed fw.OptionsModal the same shape the classic builder does: options
		// transformed into an ordered list (each { id => option }). For leaf
		// "simple" shortcodes get_shortcode_builder_data() also yields a nice
		// title; section/column don't go through that path, so fall back.
		$title       = $tag;
		$builder_row = method_exists( $shortcodes_ext, 'get_shortcode_builder_data' )
			? $shortcodes_ext->get_shortcode_builder_data( $tag )
			: null;
		if ( is_array( $builder_row ) && ! empty( $builder_row['title'] ) ) {
			$title = $builder_row['title'];
		}

		// Each shortcode declares its own modal width via `popup_size` (small /
		// medium / large) — the classic builder honors it, so mirror that here
		// instead of forcing one size for every element.
		$popup_size = ( is_array( $builder_row ) && ! empty( $builder_row['popup_size'] ) )
			? $builder_row['popup_size']
			: '';

		// section / column (and any container) bypass get_shortcode_builder_data() —
		// it bails early for non-'simple' types — so the line above yields nothing and
		// the JS falls back to the container default (large). Those shortcodes declare
		// their modal size in the config's `page_builder` section, so read it straight
		// from there; now they honor their configured size (e.g. section/column = medium).
		if ( '' === $popup_size && method_exists( $shortcode, 'get_config' ) ) {
			$pb = $shortcode->get_config( 'page_builder' );
			if ( is_array( $pb ) && ! empty( $pb['popup_size'] ) ) {
				$popup_size = $pb['popup_size'];
			}
		}

		wp_send_json_success( array(
			'tag'        => $tag,
			'title'      => $title,
			'popup_size' => $popup_size,
			'options'    => $this->transform_options_for_modal( (array) $shortcode->get_options() ),
		) );
	}

	/**
	 * Mirror of FW_Extension_Shortcodes::transform_options(): wrap each option in
	 * a single-key array so order is preserved through JSON, exactly as the
	 * classic builder feeds fw.OptionsModal.
	 *
	 * @param array $options
	 *
	 * @return array
	 */
	private function transform_options_for_modal( array $options ) {
		$out = array();
		foreach ( $options as $id => $option ) {
			$out[] = is_int( $id ) ? $option : array( $id => $option );
		}

		return $out;
	}

	/**
	 * Re-render a single builder item subtree to its front-end HTML. POST:
	 * post_id, nonce, item (JSON of one node: {type, shortcode, atts, _items, …}).
	 * Correction (auto section/row/column wrapping) is disabled so exactly the
	 * one item is produced, and the edit-render filters stamp it with its id.
	 *
	 * @internal
	 */
	public function _ajax_render_item() {
		$post_id = $this->verify_ajax();

		$item = json_decode( (string) FW_Request::POST( 'item' ), true );

		if ( ! is_array( $item ) || empty( $item['type'] ) ) {
			wp_send_json_error( array( 'message' => __( 'Invalid item.', 'fw' ) ) );
		}

		// A section re-render (e.g. after adding/rebalancing a column) needs
		// structure-correction ON so its columns are wrapped in a row; a leaf or a
		// lone column renders exactly as given.
		$html = $this->render_item_html( $item, $post_id, ! $this->is_section_type( $item['type'] ) );

		wp_send_json_success( array(
			'id'   => isset( $item['atts']['unique_id'] ) ? $item['atts']['unique_id'] : '',
			'html' => $html,
		) );
	}

	/** The section types offered in the structure picker — filtered to those whose
	 *  shortcode is registered (Bleed/Masonry ship in the shortcodes extension but
	 *  could be absent in a trimmed install). */
	private function get_section_types() {
		$this->load_shortcodes();
		$sc = fw_ext( 'shortcodes' );
		$out = array();
		$candidates = array(
			'section'         => __( 'Standard', 'fw' ),
			'bleed_section'   => __( 'Bleed', 'fw' ),
			'masonry_section' => __( 'Masonry', 'fw' ),
		);
		foreach ( $candidates as $tag => $title ) {
			if ( $sc && $sc->get_shortcode( $tag ) ) {
				$out[] = array( 'id' => $tag, 'title' => $title );
			}
		}
		return $out;
	}

	/**
	 * Flush PHP OpCache so updated plugin files actually run. On hosts with
	 * opcache.validate_timestamps=0 (e.g. WP Engine) the disk files can be current
	 * while PHP keeps executing stale bytecode — which makes shortcode views render
	 * an old way that never calls the stamping helper. Prefers a full reset; falls
	 * back to force-invalidating the Shortcodes/Page Builder PHP files.
	 *
	 * @internal
	 */
	public function _ajax_opcache_flush() {
		$this->verify_ajax();

		$out = array(
			'getStatus'   => function_exists( 'opcache_get_status' ),
			'canReset'    => function_exists( 'opcache_reset' ),
			'method'      => 'none',
			'ok'          => false,
			'invalidated' => 0,
		);

		if ( function_exists( 'opcache_reset' ) && @opcache_reset() ) {
			$out['method'] = 'reset';
			$out['ok']     = true;
		} elseif ( function_exists( 'opcache_invalidate' ) ) {
			// Targeted, force-invalidate the Shortcodes extension tree (it nests the
			// Page Builder) — that's where the stale view bytecode lives.
			$dir = dirname( __DIR__ ) . '/shortcodes';
			$count = 0;
			if ( is_dir( $dir ) ) {
				$it = new RecursiveIteratorIterator(
					new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS )
				);
				foreach ( $it as $file ) {
					$path = (string) $file;
					if ( substr( $path, -4 ) === '.php' && @opcache_invalidate( $path, true ) ) {
						$count++;
					}
				}
			}
			$out['method']      = 'invalidate';
			$out['invalidated'] = $count;
			$out['ok']          = $count > 0;
		}

		wp_send_json_success( $out );
	}

	/**
	 * Render the ENTIRE builder tree (all top-level items) to front-end HTML, with
	 * structure-correction ON and the edit-render stamping. Used by undo/redo to
	 * rebuild the whole canvas from a restored model snapshot. POST: post_id,
	 * nonce, json (the full builder tree).
	 *
	 * @internal
	 */
	public function _ajax_render_page() {
		$post_id = $this->verify_ajax();

		$json = json_decode( (string) FW_Request::POST( 'json' ), true );
		if ( ! is_array( $json ) ) {
			wp_send_json_error( array( 'message' => __( 'Invalid builder data.', 'fw' ) ) );
		}

		$this->load_shortcodes();

		global $post;
		$post = get_post( $post_id );
		if ( $post ) {
			setup_postdata( $post );
		}

		$this->force_edit_render = true;

		/** @var FW_Option_Type_Page_Builder $option_type */
		$option_type = fw()->backend->option_type( 'page-builder' );
		$shortcodes  = $option_type->json_to_shortcodes( $json );
		$html        = is_string( $shortcodes ) ? do_shortcode( $shortcodes ) : '';

		$this->force_edit_render = false;
		wp_reset_postdata();

		wp_send_json_success( array( 'html' => $html ) );
	}

	/** Whether a builder item `type` is a section-like container (section /
	 *  bleed_section / masonry_section / any *section). */
	private function is_section_type( $type ) {
		$type = (string) $type;
		return $type === 'section' || substr( $type, -7 ) === 'section';
	}

	/**
	 * Render ONE builder item subtree to its front-end HTML, with auto-correction
	 * disabled (so exactly that item is produced) and the edit-render stamping on.
	 * Shared by the re-render and new-item endpoints.
	 *
	 * @param array $item
	 * @param int   $post_id
	 *
	 * @return string
	 */
	private function render_item_html( $item, $post_id, $disable_correction = true ) {
		$this->load_shortcodes();

		// Some shortcodes read the global $post; set it up for the render.
		global $post;
		$post = get_post( $post_id );
		if ( $post ) {
			setup_postdata( $post );
		}

		$this->force_edit_render = true;
		// Leaves/columns render exactly as given (no auto section/row/column
		// wrapping). A section, however, needs correction so its columns get
		// wrapped in a row for the flex grid — so callers can opt back in.
		if ( $disable_correction ) {
			add_filter( 'fw:ext:page-builder:json-structure-needs-correction', '__return_false' );
		}

		/** @var FW_Option_Type_Page_Builder $option_type */
		$option_type = fw()->backend->option_type( 'page-builder' );
		$shortcodes  = $option_type->json_to_shortcodes( array( $item ) );
		$html        = is_string( $shortcodes ) ? do_shortcode( $shortcodes ) : '';

		if ( $disable_correction ) {
			remove_filter( 'fw:ext:page-builder:json-structure-needs-correction', '__return_false' );
		}
		$this->force_edit_render = false;
		wp_reset_postdata();

		// Some elements render to nothing when empty (e.g. a text block with no
		// text), which would make a freshly-added item invisible/unselectable in
		// the canvas. In edit mode, fall back to a placeholder card that carries
		// the item id so it can still be selected and edited.
		if ( trim( $html ) === '' ) {
			$uid   = isset( $item['atts']['unique_id'] ) ? $item['atts']['unique_id'] : '';
			$label = $this->element_label( isset( $item['shortcode'] ) ? $item['shortcode'] : $item['type'] );
			$html  = '<div class="fw-le-empty-item" data-fw-item-id="' . esc_attr( $uid ) . '">'
			       . esc_html( sprintf( __( 'Empty %s — select it and click the edit (✎) button', 'fw' ), $label ) )
			       . '</div>';
		}

		return $html;
	}

	/**
	 * A human label for an element tag (its builder title, else a titleized tag).
	 *
	 * @param string $tag
	 *
	 * @return string
	 */
	private function element_label( $tag ) {
		$sc = fw_ext( 'shortcodes' );
		if ( $sc && method_exists( $sc, 'get_shortcode_builder_data' ) ) {
			$row = $sc->get_shortcode_builder_data( $tag );
			if ( is_array( $row ) && ! empty( $row['title'] ) ) {
				return $row['title'];
			}
		}
		return ucwords( str_replace( array( '_', '-' ), ' ', (string) $tag ) );
	}

	/**
	 * Create a NEW default item of a given element type and return it + its
	 * rendered HTML. POST: post_id, nonce, tag. Used by the "Add" panel drop.
	 *
	 * @internal
	 */
	public function _ajax_new_item() {
		$post_id = $this->verify_ajax();

		$tag = (string) FW_Request::POST( 'tag' );

		$this->load_shortcodes();

		$sc        = fw_ext( 'shortcodes' );
		$shortcode = $sc ? $sc->get_shortcode( $tag ) : null;

		if ( ! $shortcode ) {
			wp_send_json_error( array( 'message' => sprintf( __( 'Unknown element: %s', 'fw' ), $tag ) ) );
		}

		// Default atts: prefer the builder data's precomputed default_values; else
		// derive them from the shortcode's options.
		$atts = array();
		$row  = method_exists( $sc, 'get_shortcode_builder_data' ) ? $sc->get_shortcode_builder_data( $tag ) : null;
		if ( is_array( $row ) && isset( $row['default_values'] ) && is_array( $row['default_values'] ) ) {
			$atts = $row['default_values'];
		} else {
			$atts = fw_get_options_values_from_input( fw_extract_only_options( $shortcode->get_options() ), array() );
		}
		$atts['unique_id'] = fw_rand_md5();

		// Give a new text block visible starter content (it renders nothing when
		// empty), so it's immediately visible and editable on the canvas.
		if ( $tag === 'text_block' && empty( $atts['text'] ) ) {
			$atts['text'] = '<p>' . __( 'Your text here…', 'fw' ) . '</p>';
		}

		$item = array(
			'type'      => 'simple',
			'shortcode' => $tag,
			'atts'      => $atts,
			'_items'    => array(),
		);

		wp_send_json_success( array(
			'item' => $item,
			'html' => $this->render_item_html( $item, $post_id ),
		) );
	}

	/**
	 * Build a fresh, empty section (one full-width column) for the canvas.
	 *
	 * Unlike a leaf element, a section is a structural container: its default
	 * atts come from the `section` shortcode's options and it carries one
	 * `column` (width `1_1`) with an empty `_items`. The HTML is rendered with
	 * the structure-correction filter LEFT ON so the lone column is wrapped in a
	 * row for the flex grid (exactly how the page renders a section), and so each
	 * container gets its data-fw-item-id stamp. The shell appends the returned
	 * item to the top-level model and drops the HTML at the end of the page.
	 *
	 * @internal
	 */
	public function _ajax_new_section() {
		$post_id = $this->verify_ajax();

		$this->load_shortcodes();
		$sc = fw_ext( 'shortcodes' );

		if ( ! $sc ) {
			wp_send_json_error( array( 'message' => __( 'Shortcodes unavailable.', 'fw' ) ) );
		}

		// Section type: Standard / Bleed / Masonry. The shortcode tag === the
		// builder item type for each. Anything else falls back to Standard.
		$type    = (string) FW_Request::POST( 'section_type', 'section' );
		$allowed = array( 'section', 'bleed_section', 'masonry_section' );
		if ( ! in_array( $type, $allowed, true ) ) {
			$type = 'section';
		}

		// Column structure: an array of width fraction ids (e.g. ['1_2','1_2']).
		$cols = FW_Request::POST( 'cols' );
		if ( is_string( $cols ) ) {
			$cols = json_decode( $cols, true );
		}
		if ( ! is_array( $cols ) || empty( $cols ) ) {
			$cols = array( '1_1' );
		}

		$section_atts = $this->default_atts( $sc, $type );
		$section_atts['unique_id'] = fw_rand_md5();

		$valid_widths = fw_ext_builder_get_item_width( 'column' ); // id => data
		$items        = array();
		foreach ( $cols as $w ) {
			$w = is_string( $w ) ? $w : '1_1';
			if ( ! isset( $valid_widths[ $w ] ) ) {
				$w = '1_1';
			}
			$items[] = $this->build_column_item( $sc, $w );
		}

		$item = array(
			'type'   => $type,
			'atts'   => $section_atts,
			'_items' => $items,
		);

		wp_send_json_success( array(
			'item' => $item,
			// Keep correction ON so the columns are wrapped in a row.
			'html' => $this->render_item_html( $item, $post_id, false ),
		) );
	}

	/**
	 * Create ONE default column item (for the "+ Column" affordance). Returns just
	 * the item; the caller re-renders the whole section (so widths rebalance and
	 * the row re-wraps correctly), so no standalone HTML is needed.
	 *
	 * @internal
	 */
	public function _ajax_new_column() {
		$post_id = $this->verify_ajax();
		$this->load_shortcodes();
		$sc = fw_ext( 'shortcodes' );

		if ( ! $sc ) {
			wp_send_json_error( array( 'message' => __( 'Shortcodes unavailable.', 'fw' ) ) );
		}

		wp_send_json_success( array( 'item' => $this->build_column_item( $sc, '1_1' ) ) );
	}

	/** Build a default column item (atts from the column shortcode, fresh id,
	 *  width as a top-level key, empty children). */
	private function build_column_item( $sc, $width ) {
		$column_atts = $this->default_atts( $sc, 'column' );
		// Width is a top-level key on a column item (sibling to atts), not an att.
		unset( $column_atts['width'] );
		$column_atts['unique_id'] = fw_rand_md5();

		return array(
			'type'   => 'column',
			'width'  => $width,
			'atts'   => $column_atts,
			'_items' => array(),
		);
	}

	public function _ajax_new_container() {
		$post_id = $this->verify_ajax();
		$this->load_shortcodes();
		$sc = fw_ext( 'shortcodes' );

		if ( ! $sc ) {
			wp_send_json_error( array( 'message' => __( 'Shortcodes unavailable.', 'fw' ) ) );
		}

		wp_send_json_success( array( 'item' => $this->build_container_item( $sc ) ) );
	}

	/** Build a default Container item (a section-level structural wrapper). It ships
	 *  with one full-width column so it is usable the moment it is added. */
	private function build_container_item( $sc ) {
		$atts = $this->default_atts( $sc, 'container' );
		$atts['unique_id'] = fw_rand_md5();

		return array(
			'type'   => 'container',
			'atts'   => $atts,
			'_items' => array( $this->build_column_item( $sc, '1_1' ) ),
		);
	}

	/** Canonical default atts for a shortcode tag — the SAME values the classic
	 *  builder seeds a new item with (its cached `default_values`, computed from
	 *  the RAW options). Using `fw_extract_only_options` here instead mangles
	 *  composite option types (e.g. the section min_height multi-picker collapses
	 *  to its Custom 600px branch), so always prefer the builder data. */
	private function default_atts( $sc, $tag ) {
		if ( $sc && method_exists( $sc, 'get_shortcode_builder_data' ) ) {
			$row = $sc->get_shortcode_builder_data( $tag );
			if ( is_array( $row ) && isset( $row['default_values'] ) && is_array( $row['default_values'] ) ) {
				return $row['default_values'];
			}
		}
		$shortcode = $sc ? $sc->get_shortcode( $tag ) : null;
		return $shortcode ? fw_get_options_values_from_input( $shortcode->get_options(), array() ) : array();
	}

	/**
	 * Persist the edited builder tree. POST: post_id, nonce, json (the full
	 * builder tree as a JSON array string — the same value the classic backend
	 * builder stores).
	 *
	 * This writes through the page-builder option exactly like the classic
	 * builder: fw_set_db_post_option() routes the value through the option type's
	 * storage_save (which re-encodes each item's atts via its item type — the
	 * symmetric inverse of the storage_load that produced our model) and then
	 * fires `fw_post_options_update`, which the page-builder extension hooks to
	 * regenerate the post_content shortcodes. So no manual meta writes and no
	 * content regeneration of our own — the framework does both correctly.
	 *
	 * @internal
	 */
	public function _ajax_save() {
		$post_id = $this->verify_ajax();

		$json    = (string) FW_Request::POST( 'json' );
		$decoded = json_decode( $json, true );

		// Must decode to an array of items; refuse anything else so a malformed
		// payload can never blank out the page.
		if ( ! is_array( $decoded ) ) {
			wp_send_json_error( array( 'message' => __( 'Invalid builder data.', 'fw' ) ) );
		}

		$this->load_shortcodes();

		// Preserve the existing builder_active flag (true for any builder page —
		// which this must be, since the editor only opens on builder posts).
		$current = fw_get_db_post_option( $post_id, $this->pb()->get_option_key() );
		$active  = ( is_array( $current ) && isset( $current['builder_active'] ) )
			? (bool) $current['builder_active']
			: true;

		fw_set_db_post_option( $post_id, $this->pb()->get_option_key(), array(
			'json'           => $json,
			'builder_active' => $active,
		) );

		// A real save supersedes any recovery autosave.
		delete_post_meta( $post_id, self::AUTOSAVE_META );

		// Snapshot this save into the revision history.
		$this->store_revision( $post_id, $json );

		wp_send_json_success( array( 'saved' => true ) );
	}

	/**
	 * Append a saved model JSON to the revision history: store it under its own
	 * meta key and prepend its metadata to the index, trimming (and deleting) the
	 * oldest beyond REVISIONS_MAX.
	 *
	 * @param int    $post_id
	 * @param string $json
	 */
	private function store_revision( $post_id, $json ) {
		$index = get_post_meta( $post_id, self::REVISIONS_INDEX_META, true );
		if ( ! is_array( $index ) ) {
			$index = array();
		}

		// Dedupe: skip if identical to the most recent revision. This also makes the
		// feature double-fire-safe — the live-editor save creates one revision and
		// the fw_post_options_update hook (which the same save triggers) then no-ops.
		if ( ! empty( $index[0]['time'] ) ) {
			$latest = get_post_meta( $post_id, self::REVISION_META_PREFIX . (int) $index[0]['time'], true );
			if ( is_string( $latest ) && $this->decode_revision( $latest ) === $json ) {
				return;
			}
		}

		$time = time();
		$user = wp_get_current_user();

		$stored = $this->encode_revision( $json );

		// wp_slash(): update_post_meta() wp_unslash()es internally; the JSON arrives
		// already-unslashed, so re-slash or its backslashes are stripped. (A no-op
		// for the compressed form — base64's alphabet contains no backslashes.)
		update_post_meta( $post_id, self::REVISION_META_PREFIX . $time, wp_slash( $stored ) );

		array_unshift( $index, array(
			'time' => $time,
			'user' => $user ? $user->ID : 0,
			'name' => $user ? $user->display_name : '',
			// Recorded so trimming never has to READ the revisions to size them —
			// reading them would trigger exactly the meta-cache load this cap exists
			// to prevent. Legacy entries have no 'bytes'; see backfill_revision_sizes().
			// This is the STORED length (post-compression), because the budget governs
			// the site's actual footprint, not the payload's uncompressed size.
			'bytes' => strlen( $stored ),
		) );

		$index = $this->trim_revisions( $post_id, $index );

		update_post_meta( $post_id, self::REVISIONS_INDEX_META, $index );
	}

	/**
	 * Marker prefixing a compressed revision payload.
	 *
	 * Versioned ('gz1') so a future change of scheme stays distinguishable, and
	 * chosen to be something a JSON document can never begin with — that is what
	 * makes decode_revision() able to read old uncompressed revisions unchanged.
	 */
	const REVISION_GZ_PREFIX = 'gz1:';

	/**
	 * Compress a revision payload for storage.
	 *
	 * Builder model JSON is extremely repetitive — the same option keys recur for
	 * every item — so it deflates by roughly an order of magnitude. base64 is
	 * needed because postmeta is a utf8mb4 TEXT column and raw deflate output is
	 * binary; it costs ~33%, which the deflate gain absorbs many times over.
	 *
	 * Falls back to the raw string if zlib is unavailable or compression fails to
	 * pay for itself, so storage never gets bigger than before.
	 *
	 * @param string $json
	 * @return string
	 */
	private function encode_revision( $json ) {
		if ( ! function_exists( 'gzcompress' ) ) {
			return $json;
		}

		$packed = @gzcompress( $json, 6 );

		if ( false === $packed ) {
			return $json;
		}

		$encoded = self::REVISION_GZ_PREFIX . base64_encode( $packed );

		return strlen( $encoded ) < strlen( $json ) ? $encoded : $json;
	}

	/**
	 * Read a stored revision payload back to JSON.
	 *
	 * Handles both forms: revisions written before compression existed are plain
	 * JSON and are returned untouched. A payload that claims to be compressed but
	 * fails to inflate returns '' rather than corrupt text, so a damaged row
	 * surfaces as an empty revision instead of a broken page.
	 *
	 * @param string $stored
	 * @return string
	 */
	private function decode_revision( $stored ) {
		if ( ! is_string( $stored ) || 0 !== strpos( $stored, self::REVISION_GZ_PREFIX ) ) {
			return is_string( $stored ) ? $stored : '';
		}

		$packed = base64_decode( substr( $stored, strlen( self::REVISION_GZ_PREFIX ) ), true );

		if ( false === $packed || ! function_exists( 'gzuncompress' ) ) {
			return '';
		}

		$json = @gzuncompress( $packed );

		return false === $json ? '' : $json;
	}

	/**
	 * One-time prune of revision history accumulated before the byte cap.
	 *
	 * Guarded by an option so it runs once per site. Finds the posts holding
	 * revision meta with a single query, then re-trims each through the same
	 * trim_revisions() path the save flow uses — so there is one definition of
	 * "too much", not a second copy that can drift.
	 *
	 * Also deletes ORPHANED revision rows: meta whose key no longer appears in
	 * its post's index. Those can never be read back or trimmed by the normal
	 * path (trimming is driven by the index), so without this they would sit
	 * there permanently.
	 *
	 * @internal
	 */
	public function _action_migrate_revision_budget() {
		if ( get_option( 'fw_le_revision_budget_migrated_v2' ) ) {
			return;
		}

		// Set first: a fatal midway must not re-run this on every admin page load.
		update_option( 'fw_le_revision_budget_migrated_v2', 1, false );
		delete_option( 'fw_le_revision_budget_migrated_v1' ); // superseded

		global $wpdb;

		$prefix   = self::REVISION_META_PREFIX;
		$post_ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT DISTINCT post_id FROM {$wpdb->postmeta} WHERE meta_key LIKE %s",
				$wpdb->esc_like( $prefix ) . '%'
			)
		);

		foreach ( (array) $post_ids as $post_id ) {
			$post_id = (int) $post_id;

			$index = get_post_meta( $post_id, self::REVISIONS_INDEX_META, true );
			$index = is_array( $index ) ? $index : array();

			$index = $this->trim_revisions( $post_id, $index );
			update_post_meta( $post_id, self::REVISIONS_INDEX_META, $index );

			// Whatever the index still references is legitimate; anything else
			// under the revision prefix is orphaned.
			$keep = array( self::REVISIONS_INDEX_META );
			foreach ( $index as $rev ) {
				if ( ! empty( $rev['time'] ) ) {
					$keep[] = $prefix . (int) $rev['time'];
				}
			}

			$placeholders = implode( ',', array_fill( 0, count( $keep ), '%s' ) );
			$wpdb->query(
				$wpdb->prepare(
					"DELETE FROM {$wpdb->postmeta}
					 WHERE post_id = %d AND meta_key LIKE %s AND meta_key NOT IN ({$placeholders})",
					array_merge( array( $post_id, $wpdb->esc_like( $prefix ) . '%' ), $keep )
				)
			);

			// Compress what survived. Pruning alone barely helps a site whose pages
			// carry multi-megabyte revisions, because REVISIONS_MIN_KEEP floors the
			// count at 2 — measured on the demos install, pruning took 150.6 MB only
			// to 115.4 MB. Real builder JSON deflates ~27x, so this is where the
			// reduction actually comes from.
			//
			// One row at a time, read and written directly: get_post_meta() would
			// prime the whole post's meta cache, which is the very cost being removed.
			$index_changed = false;

			foreach ( $index as $i => $rev ) {
				if ( empty( $rev['time'] ) ) {
					continue;
				}

				$key    = $prefix . (int) $rev['time'];
				$stored = $wpdb->get_var(
					$wpdb->prepare(
						"SELECT meta_value FROM {$wpdb->postmeta} WHERE post_id = %d AND meta_key = %s LIMIT 1",
						$post_id,
						$key
					)
				);

				if ( ! is_string( $stored ) || 0 === strpos( $stored, self::REVISION_GZ_PREFIX ) ) {
					continue; // missing, or already compressed
				}

				$packed = $this->encode_revision( $stored );

				if ( $packed === $stored ) {
					continue; // compression did not pay off
				}

				$wpdb->update(
					$wpdb->postmeta,
					array( 'meta_value' => $packed ),
					array( 'post_id' => $post_id, 'meta_key' => $key ),
					array( '%s' ),
					array( '%d', '%s' )
				);

				$index[ $i ]['bytes'] = strlen( $packed );
				$index_changed        = true;

				unset( $stored, $packed );
			}

			if ( $index_changed ) {
				update_post_meta( $post_id, self::REVISIONS_INDEX_META, $index );
			}

			wp_cache_delete( $post_id, 'post_meta' );
		}
	}

	/**
	 * Trim a revision index to both caps, deleting the meta rows it drops.
	 *
	 * Count first (cheap, exact), then bytes. Returns the trimmed index; the
	 * caller persists it. Newest-first ordering is assumed, matching store_revision().
	 *
	 * @param int   $post_id
	 * @param array $index
	 * @return array
	 */
	private function trim_revisions( $post_id, array $index ) {
		$drop = array();

		if ( count( $index ) > self::REVISIONS_MAX ) {
			foreach ( array_slice( $index, self::REVISIONS_MAX ) as $old ) {
				$drop[] = $old;
			}
			$index = array_slice( $index, 0, self::REVISIONS_MAX );
		}

		/**
		 * Total stored bytes allowed per post for revision history.
		 *
		 * @param int $bytes   Default REVISIONS_MAX_BYTES.
		 * @param int $post_id
		 */
		$budget = (int) apply_filters( 'fw_le_revisions_max_bytes', self::REVISIONS_MAX_BYTES, $post_id );

		if ( $budget > 0 ) {
			$index = $this->backfill_revision_sizes( $post_id, $index );

			$running = 0;
			$keep    = array();

			foreach ( $index as $i => $rev ) {
				$running += isset( $rev['bytes'] ) ? (int) $rev['bytes'] : 0;

				// The floor beats the budget: never leave a page with no usable
				// history just because its revisions are large.
				if ( $i < self::REVISIONS_MIN_KEEP || $running <= $budget ) {
					$keep[] = $rev;
				} else {
					$drop[] = $rev;
				}
			}

			$index = $keep;
		}

		foreach ( $drop as $old ) {
			if ( ! empty( $old['time'] ) ) {
				delete_post_meta( $post_id, self::REVISION_META_PREFIX . (int) $old['time'] );
			}
		}

		return $index;
	}

	/**
	 * Fill in 'bytes' for index entries written before it was recorded.
	 *
	 * Sizes come from ONE direct LENGTH() query rather than get_post_meta() per
	 * revision: get_post_meta() would prime the post's whole meta cache — tens of
	 * megabytes on exactly the posts this cap targets — to learn a number MySQL
	 * can report without sending the payload at all.
	 *
	 * @param int   $post_id
	 * @param array $index
	 * @return array
	 */
	private function backfill_revision_sizes( $post_id, array $index ) {
		$missing = array();

		foreach ( $index as $rev ) {
			if ( ! isset( $rev['bytes'] ) && ! empty( $rev['time'] ) ) {
				$missing[] = self::REVISION_META_PREFIX . (int) $rev['time'];
			}
		}

		if ( ! $missing ) {
			return $index;
		}

		global $wpdb;

		$placeholders = implode( ',', array_fill( 0, count( $missing ), '%s' ) );
		$rows         = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT meta_key, LENGTH(meta_value) AS len FROM {$wpdb->postmeta}
				 WHERE post_id = %d AND meta_key IN ({$placeholders})",
				array_merge( array( $post_id ), $missing )
			),
			ARRAY_A
		);

		$sizes = array();
		foreach ( (array) $rows as $row ) {
			$sizes[ $row['meta_key'] ] = (int) $row['len'];
		}

		foreach ( $index as $i => $rev ) {
			if ( ! isset( $rev['bytes'] ) && ! empty( $rev['time'] ) ) {
				$key                    = self::REVISION_META_PREFIX . (int) $rev['time'];
				$index[ $i ]['bytes'] = isset( $sizes[ $key ] ) ? $sizes[ $key ] : 0;
			}
		}

		return $index;
	}

	/**
	 * Snapshot the builder content into the revision history when it is saved
	 * through any editor. Fires on `fw_post_options_update`: option_id is the
	 * page-builder key for the live editor's direct save, or null for the backend's
	 * full post-options save — both mean the content may have changed.
	 *
	 * @param int        $post_id
	 * @param string|null $option_id
	 * @internal
	 */
	public function _action_snapshot_revision( $post_id, $option_id ) {
		$pb = $this->pb();
		if ( ! $pb || ! $pb->is_builder_post( $post_id ) ) {
			return;
		}

		// Only the whole-post save (null) or the builder content option itself —
		// not an unrelated single-option update.
		if ( null !== $option_id && '' !== $option_id && $pb->get_option_key() !== $option_id ) {
			return;
		}

		$data = fw_get_db_post_option( $post_id, $pb->get_option_key() );
		$json = ( is_array( $data ) && isset( $data['json'] ) ) ? (string) $data['json'] : '';

		if ( '' === $json || null === json_decode( $json, true ) ) {
			return;
		}

		$this->store_revision( $post_id, $json ); // dedupe inside
	}

	/**
	 * Return the revision list (metadata only — newest first) for the History
	 * panel. The newest entry is the current saved state.
	 *
	 * @internal
	 */
	public function _ajax_revisions() {
		$post_id = $this->verify_ajax();

		$index = get_post_meta( $post_id, self::REVISIONS_INDEX_META, true );
		$out   = array();

		if ( is_array( $index ) ) {
			$first = true;
			foreach ( $index as $rev ) {
				if ( empty( $rev['time'] ) ) {
					continue;
				}
				$out[] = array(
					'id'       => (int) $rev['time'],
					'name'     => isset( $rev['name'] ) && $rev['name'] !== '' ? (string) $rev['name'] : __( 'Unknown', 'fw' ),
					'timeText' => sprintf(
						/* translators: %s: human-readable time difference, e.g. "5 mins" */
						__( '%s ago', 'fw' ),
						human_time_diff( (int) $rev['time'] )
					),
					'current'  => $first,
				);
				$first = false;
			}
		}

		wp_send_json_success( array( 'revisions' => $out ) );
	}

	/**
	 * Return one revision's full model JSON (by its `id` = timestamp).
	 *
	 * @internal
	 */
	public function _ajax_revision_get() {
		$post_id = $this->verify_ajax();

		$id     = (int) FW_Request::POST( 'id' );
		$stored = $id ? get_post_meta( $post_id, self::REVISION_META_PREFIX . $id, true ) : '';

		// Revisions may be stored compressed or (pre-2.16.20) as raw JSON.
		$json = $this->decode_revision( $stored );

		if ( ! is_string( $json ) || $json === '' || json_decode( $json, true ) === null ) {
			wp_send_json_error( array( 'message' => __( 'Revision not found.', 'fw' ) ) );
		}

		wp_send_json_success( array( 'json' => $json ) );
	}

	/**
	 * A pending autosave to offer for restore: present only when an autosave exists
	 * AND it is newer than the page's last real save (post_modified). The timestamp
	 * check also prevents an old autosave from reverting later backend edits.
	 *
	 * @param WP_Post $post
	 *
	 * @return array { has, json?, timeText? }
	 */
	private function get_pending_autosave( WP_Post $post ) {
		$raw = get_post_meta( $post->ID, self::AUTOSAVE_META, true );

		if ( ! is_array( $raw ) || empty( $raw['json'] ) || empty( $raw['time'] ) ) {
			return array( 'has' => false );
		}

		$modified = (int) get_post_modified_time( 'U', true, $post );
		if ( (int) $raw['time'] <= $modified ) {
			return array( 'has' => false ); // last save is newer — nothing to recover
		}

		return array(
			'has'      => true,
			'json'     => (string) $raw['json'],
			'timeText' => sprintf(
				/* translators: %s: human-readable time difference, e.g. "5 mins" */
				__( '%s ago', 'fw' ),
				human_time_diff( (int) $raw['time'] )
			),
		);
	}

	/**
	 * Background recovery autosave. Stores the working builder JSON in a SEPARATE
	 * post meta (never the live page-builder option) so a crash / accidental close
	 * doesn't lose work — surfaced as a "restore unsaved changes" prompt on reopen.
	 * POST `clear=1` removes it (used when the user discards the recovered version).
	 *
	 * @internal
	 */
	public function _ajax_autosave() {
		$post_id = $this->verify_ajax();

		if ( FW_Request::POST( 'clear' ) ) {
			delete_post_meta( $post_id, self::AUTOSAVE_META );
			wp_send_json_success();
		}

		$json    = (string) FW_Request::POST( 'json' );
		$decoded = json_decode( $json, true );
		if ( ! is_array( $decoded ) ) {
			wp_send_json_error( array( 'message' => __( 'Invalid builder data.', 'fw' ) ) );
		}

		$time = time();
		// wp_slash(): update_post_meta() runs wp_unslash() on the value internally,
		// but FW_Request::POST() already returned the JSON unslashed — so slash it
		// back here, or every \" / \\ / \n in the JSON loses a backslash and it
		// becomes unparseable on reload.
		update_post_meta( $post_id, self::AUTOSAVE_META, wp_slash( array(
			'json' => $json,
			'time' => $time,
			'user' => get_current_user_id(),
		) ) );

		wp_send_json_success( array( 'time' => $time ) );
	}

}
