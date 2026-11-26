<?php if ( ! defined( 'FW' ) ) {
	die( 'Forbidden' );
}

/**
 * Working together in the Live Editor (roadmap 7i).
 *
 *  - Comments pinned to an element: threads with replies, resolve / reopen, kept in post meta apart from the page
 *    content (commenting never changes the page). The people in a thread get an email when someone answers.
 *  - Presence: every open editor sends a pulse (who, which element is selected, which device) every few seconds;
 *    each one sees the others, and is told when someone else saved the page after it was opened.
 *  - Staging copy: a draft copy of a page to change and review (with a share link that works without logging in),
 *    then publish onto the live page in one step (the live page's version is kept in its revision history first)
 *    or discard.
 *
 * One AJAX action, `fw_le_collab`, with `op`; the same nonce and permission as the rest of the Live Editor.
 */
class FW_LE_Collab {

	const COMMENTS_META = '_fw_le_comments';
	const SAVED_META    = '_fw_le_saved';
	const STAGING_OF    = '_fw_staging_of';
	const STAGE_TOKEN   = '_fw_stage_token';
	const PRESENCE_TTL  = 45;  // seconds a pulse keeps someone "here"
	const MAX_THREADS   = 300;
	const MAX_TEXT      = 2000;

	/** @var FW_Extension_Live_Editor */
	private static $ext;

	public static function init( $ext ) {
		self::$ext = $ext;
		add_action( 'wp_ajax_fw_le_collab', array( __CLASS__, 'ajax' ) );
		// Who saved last, and when: the presence pulse tells the others.
		add_action( 'fw_post_options_update', array( __CLASS__, 'mark_saved' ), 20, 2 );
		// A staging copy's review link works without logging in.
		add_filter( 'posts_results', array( __CLASS__, 'review_link_results' ), 10, 2 );
		add_action( 'template_redirect', array( __CLASS__, 'review_link_headers' ) );
	}

	/** Config for the shell script (merged into _fwLiveEditor.collab). */
	public static function config( WP_Post $post ) {
		$me  = wp_get_current_user();
		$of  = (int) get_post_meta( $post->ID, self::STAGING_OF, true );
		$cfg = array(
			'me'       => array( 'id' => (int) $me->ID, 'name' => $me->display_name, 'color' => self::color( $me->ID ) ),
			'interval' => 8000,
			'saved'    => self::saved_info( $post->ID ),
			'staging'  => null,
			'copies'   => array(),
		);
		if ( $of && get_post( $of ) ) {
			$cfg['staging'] = array(
				'of'    => $of,
				'title' => get_the_title( $of ),
				'url'   => get_permalink( $of ),
				'edit'  => self::editor_url( $of ),
				'can'   => current_user_can( 'edit_post', $of ),
			);
		} else {
			$cfg['copies'] = self::copies_of( $post->ID );
		}
		return $cfg;
	}

	public static function ajax() {
		$post_id = (int) FW_Request::POST( 'post_id' );
		if ( ! $post_id || ! wp_verify_nonce( (string) FW_Request::POST( 'nonce' ), 'fw-live-editor:' . $post_id ) || ! current_user_can( 'edit_post', $post_id ) ) {
			wp_send_json_error( array( 'message' => __( 'Permission denied.', 'fw' ) ), 403 );
		}
		$op = sanitize_key( (string) FW_Request::POST( 'op' ) );
		switch ( $op ) {
			case 'pulse':
				wp_send_json_success( self::pulse( $post_id ) );
				break;
			case 'comments':
				wp_send_json_success( array( 'threads' => self::threads( $post_id ) ) );
				break;
			case 'comment_add':
				$r = self::comment_add( $post_id );
				is_wp_error( $r ) ? wp_send_json_error( array( 'message' => $r->get_error_message() ) ) : wp_send_json_success( array( 'threads' => $r ) );
				break;
			case 'comment_resolve':
			case 'comment_delete':
				$r = self::comment_change( $post_id, $op );
				is_wp_error( $r ) ? wp_send_json_error( array( 'message' => $r->get_error_message() ) ) : wp_send_json_success( array( 'threads' => $r ) );
				break;
			case 'stage_create':
				$r = self::stage_create( $post_id );
				is_wp_error( $r ) ? wp_send_json_error( array( 'message' => $r->get_error_message() ) ) : wp_send_json_success( $r );
				break;
			case 'stage_share':
				$r = self::stage_share( $post_id, (bool) FW_Request::POST( 'off' ) );
				is_wp_error( $r ) ? wp_send_json_error( array( 'message' => $r->get_error_message() ) ) : wp_send_json_success( $r );
				break;
			case 'stage_publish':
				$r = self::stage_publish( $post_id, 'keep' === FW_Request::POST( 'copy' ) );
				is_wp_error( $r ) ? wp_send_json_error( array( 'message' => $r->get_error_message() ) ) : wp_send_json_success( $r );
				break;
			case 'stage_discard':
				$r = self::stage_discard( $post_id );
				is_wp_error( $r ) ? wp_send_json_error( array( 'message' => $r->get_error_message() ) ) : wp_send_json_success( $r );
				break;
			default:
				wp_send_json_error( array( 'message' => 'Unknown operation.' ) );
		}
	}

	/* ------------------------------------------------------------------ *
	 * Presence
	 * ------------------------------------------------------------------ */

	private static function pulse( $post_id ) {
		$me   = wp_get_current_user();
		$key  = 'fw_le_presence_' . $post_id;
		$all  = get_transient( $key );
		$all  = is_array( $all ) ? $all : array();
		$now  = time();
		$item = preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) FW_Request::POST( 'item' ) );
		$dev  = in_array( FW_Request::POST( 'device' ), array( 'desktop', 'tablet', 'mobile' ), true ) ? FW_Request::POST( 'device' ) : 'desktop';
		if ( FW_Request::POST( 'leave' ) ) {
			unset( $all[ $me->ID ] );
		} else {
			$all[ $me->ID ] = array( 't' => $now, 'item' => substr( $item, 0, 64 ), 'device' => $dev, 'dirty' => (bool) FW_Request::POST( 'dirty' ) );
		}
		foreach ( $all as $uid => $p ) {
			if ( ! is_array( $p ) || $now - (int) $p['t'] > self::PRESENCE_TTL ) {
				unset( $all[ $uid ] );
			}
		}
		set_transient( $key, $all, self::PRESENCE_TTL * 4 );

		$others = array();
		foreach ( $all as $uid => $p ) {
			if ( (int) $uid === (int) $me->ID ) {
				continue;
			}
			$u = get_userdata( (int) $uid );
			if ( ! $u ) {
				continue;
			}
			$others[] = array(
				'id'     => (int) $uid,
				'name'   => $u->display_name,
				'avatar' => get_avatar_url( (int) $uid, array( 'size' => 48 ) ),
				'color'  => self::color( (int) $uid ),
				'item'   => $p['item'],
				'device' => $p['device'],
				'dirty'  => ! empty( $p['dirty'] ),
				'ago'    => $now - (int) $p['t'],
			);
		}
		$threads = get_post_meta( $post_id, self::COMMENTS_META, true );
		return array(
			'others'   => $others,
			'saved'    => self::saved_info( $post_id ),
			'comments' => is_array( $threads ) ? md5( wp_json_encode( $threads ) ) : '',
		);
	}

	public static function mark_saved( $post_id, $option_id ) {
		if ( null !== $option_id && '' !== $option_id && 'page-builder' !== $option_id ) {
			return;
		}
		update_post_meta( $post_id, self::SAVED_META, array( 't' => time(), 'u' => get_current_user_id() ) );
	}

	private static function saved_info( $post_id ) {
		$s = get_post_meta( $post_id, self::SAVED_META, true );
		if ( ! is_array( $s ) || empty( $s['t'] ) ) {
			return array( 't' => 0, 'u' => 0, 'name' => '' );
		}
		$u = get_userdata( (int) $s['u'] );
		return array( 't' => (int) $s['t'], 'u' => (int) $s['u'], 'name' => $u ? $u->display_name : '' );
	}

	/** A steady, readable colour per person. */
	private static function color( $uid ) {
		$palette = array( '#e5484d', '#2f74e6', '#00b295', '#e0890b', '#8e4ec6', '#d6409f', '#0d9488', '#ca8a04' );
		return $palette[ absint( $uid ) % count( $palette ) ];
	}

	/* ------------------------------------------------------------------ *
	 * Comments
	 * ------------------------------------------------------------------ */

	private static function threads( $post_id ) {
		$t = get_post_meta( $post_id, self::COMMENTS_META, true );
		$t = is_array( $t ) ? $t : array();
		$out = array();
		foreach ( $t as $th ) {
			$th['avatar']  = get_avatar_url( (int) $th['user'], array( 'size' => 48 ) );
			$th['mine']    = (int) $th['user'] === get_current_user_id();
			foreach ( $th['replies'] as $i => $r ) {
				$th['replies'][ $i ]['avatar'] = get_avatar_url( (int) $r['user'], array( 'size' => 48 ) );
				$th['replies'][ $i ]['mine']   = (int) $r['user'] === get_current_user_id();
			}
			$out[] = $th;
		}
		return $out;
	}

	private static function comment_add( $post_id ) {
		$text = trim( sanitize_textarea_field( (string) FW_Request::POST( 'text' ) ) );
		if ( '' === $text ) {
			return new WP_Error( 'empty', __( 'Write a comment first.', 'fw' ) );
		}
		$text   = mb_substr( $text, 0, self::MAX_TEXT );
		$me     = wp_get_current_user();
		$parent = preg_replace( '/[^A-Za-z0-9]/', '', (string) FW_Request::POST( 'parent' ) ); // ids are mixed case
		$t      = get_post_meta( $post_id, self::COMMENTS_META, true );
		$t      = is_array( $t ) ? $t : array();
		$entry  = array( 'id' => wp_generate_password( 10, false, false ), 'user' => (int) $me->ID, 'name' => $me->display_name, 't' => time(), 'text' => $text );
		if ( $parent ) {
			$found = false;
			foreach ( $t as $i => $th ) {
				if ( $th['id'] === $parent ) {
					$t[ $i ]['replies'][] = $entry;
					$t[ $i ]['resolved']  = false;
					$found                = $t[ $i ];
					break;
				}
			}
			if ( ! $found ) {
				return new WP_Error( 'gone', __( 'That comment was deleted.', 'fw' ) );
			}
			update_post_meta( $post_id, self::COMMENTS_META, $t );
			self::notify( $post_id, $found, $entry );
		} else {
			if ( count( $t ) >= self::MAX_THREADS ) {
				return new WP_Error( 'full', __( 'This page has too many comments. Delete resolved ones first.', 'fw' ) );
			}
			$item = preg_replace( '/[^a-zA-Z0-9_-]/', '', (string) FW_Request::POST( 'item' ) );
			$t[]  = $entry + array(
				'item'     => substr( $item, 0, 64 ),
				'label'    => mb_substr( sanitize_text_field( (string) FW_Request::POST( 'label' ) ), 0, 80 ),
				'resolved' => false,
				'replies'  => array(),
			);
			update_post_meta( $post_id, self::COMMENTS_META, $t );
			$author = (int) get_post_field( 'post_author', $post_id );
			if ( $author && $author !== (int) $me->ID ) {
				self::mail( array( $author ), $post_id, $me->display_name, $text );
			}
		}
		return self::threads( $post_id );
	}

	private static function comment_change( $post_id, $op ) {
		$id = preg_replace( '/[^A-Za-z0-9]/', '', (string) FW_Request::POST( 'id' ) ); // ids are mixed case
		$t  = get_post_meta( $post_id, self::COMMENTS_META, true );
		$t  = is_array( $t ) ? $t : array();
		$me = get_current_user_id();
		foreach ( $t as $i => $th ) {
			if ( $th['id'] === $id ) {
				if ( 'comment_resolve' === $op ) {
					$t[ $i ]['resolved'] = (bool) FW_Request::POST( 'resolved' );
				} else {
					if ( (int) $th['user'] !== $me && ! current_user_can( 'edit_others_posts' ) ) {
						return new WP_Error( 'forbidden', __( 'Only its author or an editor can delete this comment.', 'fw' ) );
					}
					array_splice( $t, $i, 1 );
				}
				update_post_meta( $post_id, self::COMMENTS_META, array_values( $t ) );
				return self::threads( $post_id );
			}
			foreach ( (array) $th['replies'] as $j => $r ) {
				if ( $r['id'] === $id && 'comment_delete' === $op ) {
					if ( (int) $r['user'] !== $me && ! current_user_can( 'edit_others_posts' ) ) {
						return new WP_Error( 'forbidden', __( 'Only its author or an editor can delete this reply.', 'fw' ) );
					}
					array_splice( $t[ $i ]['replies'], $j, 1 );
					update_post_meta( $post_id, self::COMMENTS_META, $t );
					return self::threads( $post_id );
				}
			}
		}
		return new WP_Error( 'gone', __( 'That comment was already deleted.', 'fw' ) );
	}

	/** Everyone in the thread except the person who just answered gets an email. */
	private static function notify( $post_id, array $thread, array $entry ) {
		$to = array( (int) $thread['user'] );
		foreach ( (array) $thread['replies'] as $r ) {
			$to[] = (int) $r['user'];
		}
		$to = array_diff( array_unique( $to ), array( (int) $entry['user'] ) );
		if ( $to ) {
			self::mail( $to, $post_id, $entry['name'], $entry['text'] );
		}
	}

	private static function mail( array $user_ids, $post_id, $from_name, $text ) {
		if ( ! apply_filters( 'fw_le_comment_emails', true, $post_id ) ) {
			return;
		}
		$emails = array();
		foreach ( $user_ids as $uid ) {
			$u = get_userdata( $uid );
			if ( $u && is_email( $u->user_email ) ) {
				$emails[] = $u->user_email;
			}
		}
		if ( ! $emails ) {
			return;
		}
		$title = get_the_title( $post_id );
		/* translators: 1: person, 2: page title */
		$subject = sprintf( __( '%1$s commented on "%2$s"', 'fw' ), $from_name, $title );
		$body    = $text . "\n\n" . __( 'Open the page in the Live Editor to answer:', 'fw' ) . "\n" . self::editor_url( $post_id );
		wp_mail( $emails, $subject, $body );
	}

	/* ------------------------------------------------------------------ *
	 * Staging copies
	 * ------------------------------------------------------------------ */

	private static function editor_url( $post_id ) {
		return add_query_arg( 'fw-live-editor', 1, get_permalink( $post_id ) );
	}

	private static function copies_of( $post_id ) {
		$q   = get_posts( array( 'post_type' => get_post_type( $post_id ), 'post_status' => array( 'draft', 'pending', 'private' ), 'meta_key' => self::STAGING_OF, 'meta_value' => (string) $post_id, 'numberposts' => 10 ) );
		$out = array();
		foreach ( $q as $c ) {
			$u     = get_userdata( (int) $c->post_author );
			$out[] = array( 'id' => $c->ID, 'by' => $u ? $u->display_name : '', 'modified' => get_post_modified_time( 'U', true, $c ), 'edit' => self::editor_url( $c->ID ) );
		}
		return $out;
	}

	/** Meta that belongs to ONE post and must not travel between a page and its staging copy. */
	private static function skip_meta( $key ) {
		return in_array( $key, array( '_edit_lock', '_edit_last', '_wp_old_slug', '_wp_old_date', '_thumbnail_id_old', self::STAGING_OF, self::STAGE_TOKEN, self::COMMENTS_META, self::SAVED_META, FW_Extension_Live_Editor::AUTOSAVE_META, FW_Extension_Live_Editor::REVISIONS_INDEX_META ), true )
			|| 0 === strpos( $key, FW_Extension_Live_Editor::REVISION_META_PREFIX )
			|| 0 === strpos( $key, '_wp_trash_' );
	}

	private static function copy_meta( $from, $to ) {
		foreach ( get_post_meta( $to ) as $key => $vals ) {
			if ( ! self::skip_meta( $key ) ) {
				delete_post_meta( $to, $key );
			}
		}
		foreach ( get_post_meta( $from ) as $key => $vals ) {
			if ( self::skip_meta( $key ) ) {
				continue;
			}
			foreach ( $vals as $v ) {
				add_post_meta( $to, $key, wp_slash( maybe_unserialize( $v ) ) );
			}
		}
	}

	private static function stage_create( $post_id ) {
		if ( get_post_meta( $post_id, self::STAGING_OF, true ) ) {
			return new WP_Error( 'nested', __( 'This is already a staging copy.', 'fw' ) );
		}
		$p  = get_post( $post_id );
		$id = wp_insert_post( wp_slash( array(
			'post_type'    => $p->post_type,
			'post_status'  => 'draft',
			/* translators: %s: page title */
			'post_title'   => sprintf( __( '%s (staging copy)', 'fw' ), $p->post_title ),
			'post_content' => $p->post_content,
			'post_excerpt' => $p->post_excerpt,
			'post_parent'  => $p->post_parent,
			'menu_order'   => $p->menu_order,
			'post_author'  => get_current_user_id(),
		) ), true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		self::copy_meta( $post_id, $id );
		update_post_meta( $id, self::STAGING_OF, $post_id );
		return array( 'id' => $id, 'edit' => self::editor_url( $id ) );
	}

	private static function stage_share( $copy_id, $off ) {
		if ( ! get_post_meta( $copy_id, self::STAGING_OF, true ) ) {
			return new WP_Error( 'not_staging', __( 'Only a staging copy can be shared this way.', 'fw' ) );
		}
		if ( $off ) {
			delete_post_meta( $copy_id, self::STAGE_TOKEN );
			return array( 'url' => '' );
		}
		$token = get_post_meta( $copy_id, self::STAGE_TOKEN, true );
		if ( ! $token ) {
			$token = wp_generate_password( 24, false, false );
			update_post_meta( $copy_id, self::STAGE_TOKEN, $token );
		}
		return array( 'url' => self::review_url( $copy_id, $token ) );
	}

	private static function review_url( $copy_id, $token ) {
		$type = get_post_type( $copy_id );
		$arg  = 'page' === $type ? 'page_id' : 'p';
		return add_query_arg( array( $arg => $copy_id, 'post_type' => 'page' === $type ? false : $type, 'fw-review' => $token ), home_url( '/' ) );
	}

	private static function stage_publish( $copy_id, $keep_copy ) {
		$orig = (int) get_post_meta( $copy_id, self::STAGING_OF, true );
		if ( ! $orig || ! get_post( $orig ) ) {
			return new WP_Error( 'not_staging', __( 'The live page of this copy no longer exists.', 'fw' ) );
		}
		if ( ! current_user_can( 'edit_post', $orig ) ) {
			return new WP_Error( 'forbidden', __( 'You cannot change the live page.', 'fw' ) );
		}
		// The live page as it is now goes into its revision history, so this can be undone from Revision history.
		if ( self::$ext && method_exists( self::$ext, '_action_snapshot_revision' ) ) {
			self::$ext->_action_snapshot_revision( $orig, null );
		}
		$c = get_post( $copy_id );
		wp_update_post( wp_slash( array( 'ID' => $orig, 'post_content' => $c->post_content, 'post_excerpt' => $c->post_excerpt ) ) );
		self::copy_meta( $copy_id, $orig );
		// Re-save the builder content through the options API, so its caches, revision snapshot and generated CSS
		// refresh exactly as after a normal Save.
		$pb = fw_get_db_post_option( $copy_id, 'page-builder' );
		if ( is_array( $pb ) ) {
			fw_set_db_post_option( $orig, 'page-builder', $pb );
		}
		clean_post_cache( $orig );
		do_action( 'fw_le_staging_published', $orig, $copy_id );
		if ( ! $keep_copy ) {
			wp_trash_post( $copy_id );
		}
		return array( 'url' => get_permalink( $orig ), 'edit' => self::editor_url( $orig ) );
	}

	private static function stage_discard( $copy_id ) {
		$orig = (int) get_post_meta( $copy_id, self::STAGING_OF, true );
		if ( ! $orig ) {
			return new WP_Error( 'not_staging', __( 'This is not a staging copy.', 'fw' ) );
		}
		wp_trash_post( $copy_id );
		return array( 'edit' => get_post( $orig ) ? self::editor_url( $orig ) : admin_url() );
	}

	/** ?fw-review=<token> shows that staging copy to anyone with the link (read only, not indexed). */
	public static function review_link_results( $posts, $query ) {
		if ( empty( $_GET['fw-review'] ) || ! $query->is_main_query() || count( $posts ) !== 1 ) { // phpcs:ignore WordPress.Security.NonceVerification
			return $posts;
		}
		$p     = $posts[0];
		$token = (string) get_post_meta( $p->ID, self::STAGE_TOKEN, true );
		if ( $token && get_post_meta( $p->ID, self::STAGING_OF, true ) && hash_equals( $token, (string) wp_unslash( $_GET['fw-review'] ) ) && 'publish' !== $p->post_status ) { // phpcs:ignore
			$p->post_status = 'publish';
			$GLOBALS['fw_le_reviewing'] = true;
		}
		return $posts;
	}

	public static function review_link_headers() {
		if ( ! empty( $GLOBALS['fw_le_reviewing'] ) ) {
			header( 'X-Robots-Tag: noindex, nofollow', true );
			// After the SEO extension's own wp_robots filter (999), which would otherwise say index, follow.
			add_filter( 'wp_robots', function ( $r ) {
				unset( $r['index'], $r['follow'], $r['max-image-preview'] );
				$r['noindex']  = true;
				$r['nofollow'] = true;
				return $r;
			}, 1000 );
		}
	}
}
