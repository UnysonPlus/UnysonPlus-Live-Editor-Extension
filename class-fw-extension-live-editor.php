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

		if ( ! is_admin() ) {
			add_filter( 'template_include', array( $this, '_filter_template_include' ), 999 );
			add_action( 'wp_enqueue_scripts', array( $this, '_action_enqueue_assets' ) );
			add_filter( 'body_class', array( $this, '_filter_body_class' ) );
			// Suppress the WP admin bar inside both the shell and the iframe — the
			// editor provides its own toolbar and the bar only adds clutter / height.
			add_filter( 'show_admin_bar', array( $this, '_filter_show_admin_bar' ), 99 );
		}
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
	 * @return bool
	 */
	private function is_frame_request() {
		return $this->request_targets_editable_builder_post( $this->frame_query_var );
	}

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

		$wp_admin_bar->add_node( array(
			'id'    => 'fw-live-editor',
			'title' => '<span class="ab-icon dashicons dashicons-edit" style="top:2px;"></span>'
			         . esc_html__( 'Edit Live', 'fw' ),
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
	 *
	 * @param WP_Post $post
	 *
	 * @return string
	 */
	public function get_frame_url( WP_Post $post ) {
		return add_query_arg( $this->frame_query_var, 1, get_permalink( $post->ID ) );
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
	 * Assets for the editor chrome (the shell document around the iframe).
	 */
	private function enqueue_shell_assets() {
		$ver  = $this->manifest->get_version();
		$post = get_queried_object();

		wp_enqueue_style(
			'fw-live-editor',
			fw_min_uri( $this->get_declared_URI( '/static/css/live-editor.css' ) ),
			array( 'dashicons' ),
			$ver
		);

		wp_enqueue_script(
			'fw-live-editor',
			fw_min_uri( $this->get_declared_URI( '/static/js/live-editor.js' ) ),
			array( 'jquery' ),
			$ver,
			true
		);

		$builder_data = fw_get_db_post_option( $post->ID, $this->pb()->get_option_key() );

		wp_localize_script( 'fw-live-editor', '_fwLiveEditor', array(
			'postId'   => (int) $post->ID,
			'frameUrl' => $this->get_frame_url( $post ),
			'exitUrl'  => get_permalink( $post->ID ),
			'ajaxUrl'  => admin_url( 'admin-ajax.php' ),
			'nonce'    => wp_create_nonce( 'fw-live-editor:' . $post->ID ),
			// The single source of truth: the same builder JSON the classic
			// backend builder stores. Later phases edit this in place and save
			// it back to the page-builder post option.
			'builder'  => array(
				'json' => isset( $builder_data['json'] ) ? $builder_data['json'] : '[]',
			),
			'l10n'     => array(
				'title'      => __( 'Live Editor', 'fw' ),
				'save'       => __( 'Save', 'fw' ),
				'exit'       => __( 'Exit', 'fw' ),
				'connecting' => __( 'Connecting…', 'fw' ),
				'ready'      => __( 'Ready', 'fw' ),
			),
		) );
	}

	/**
	 * Assets for the document inside the iframe (the live canvas bridge).
	 * Phase 0: just the postMessage handshake + a body hook for edit-mode CSS.
	 * Phase 1 grows this into the selection / outline layer.
	 */
	private function enqueue_frame_assets() {
		$ver = $this->manifest->get_version();

		wp_enqueue_style(
			'fw-live-editor-frame',
			fw_min_uri( $this->get_declared_URI( '/static/css/live-editor-frame.css' ) ),
			array(),
			$ver
		);

		wp_enqueue_script(
			'fw-live-editor-frame',
			fw_min_uri( $this->get_declared_URI( '/static/js/live-editor-frame.js' ) ),
			array( 'jquery' ),
			$ver,
			true
		);

		wp_localize_script( 'fw-live-editor-frame', '_fwLiveEditorFrame', array(
			'postId' => (int) get_queried_object_id(),
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
}
