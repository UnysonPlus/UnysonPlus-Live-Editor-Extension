<?php if ( ! defined( 'FW' ) ) {
	die( 'Forbidden' );
}

/**
 * The Live Editor "shell" document.
 *
 * Rendered instead of the theme template when a builder page is opened with
 * `?fw-live-editor=1` (see FW_Extension_Live_Editor::_filter_template_include()).
 * It is a minimal, self-contained HTML document — deliberately NOT the theme
 * header/footer — whose only job is to host the editor chrome and embed the
 * live page in an isolated <iframe>. All editor styling/behaviour is enqueued
 * onto this document; the iframe loads the real page untouched.
 *
 * @var WP_Post $fw_le_post resolved below
 */

$fw_le_post = get_queried_object();

if ( ! $fw_le_post instanceof WP_Post ) {
	// Guard: should never happen (the boot guard already vetted this), but bail
	// to the home page rather than render a broken shell.
	wp_safe_redirect( home_url( '/' ) );
	exit;
}

/** @var FW_Extension_Live_Editor $fw_le_ext */
$fw_le_ext       = fw_ext( 'live-editor' );
$fw_le_frame_url = $fw_le_ext ? $fw_le_ext->get_frame_url( $fw_le_post ) : get_permalink( $fw_le_post );

?><!doctype html>
<html <?php language_attributes(); ?> class="fw-live-editor-html">
<head>
	<meta charset="<?php bloginfo( 'charset' ); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
	<title><?php
		/* translators: %s: page title being edited */
		echo esc_html( sprintf( __( 'Live Editor — %s', 'fw' ), get_the_title( $fw_le_post ) ) );
	?></title>
	<?php
	// The framework's options runtime (fw.js) calls `ajaxurl` when rendering option
	// HTML — a global that only exists in wp-admin. Define it before any framework
	// script runs so the options modal works on this front-end shell.
	?>
	<script>window.ajaxurl = window.ajaxurl || <?php echo wp_json_encode( admin_url( 'admin-ajax.php' ) ); ?>;</script>
	<?php wp_head(); ?>
</head>
<body class="fw-live-editor-shell">

	<div id="fw-live-editor-app" class="fw-le-app">

		<header id="fw-le-toolbar" class="fw-le-toolbar">
			<div class="fw-le-toolbar__group fw-le-toolbar__group--left">
				<span class="fw-le-brand">
					<span class="dashicons dashicons-layout"></span>
					<?php echo esc_html__( 'Live Editor', 'fw' ); ?>
				</span>
				<span id="fw-le-status" class="fw-le-status" data-state="connecting">
					<?php echo esc_html__( 'Connecting…', 'fw' ); ?>
				</span>
				<span class="fw-le-doc-title"><?php echo esc_html( get_the_title( $fw_le_post ) ); ?></span>
			</div>

			<div class="fw-le-toolbar__group fw-le-toolbar__group--center">
				<div id="fw-le-devices" class="fw-le-devices" role="group" aria-label="<?php echo esc_attr__( 'Preview device', 'fw' ); ?>">
					<button type="button" class="fw-le-device is-active" data-device="desktop" title="<?php echo esc_attr__( 'Desktop', 'fw' ); ?>">
						<span class="dashicons dashicons-desktop"></span>
					</button>
					<button type="button" class="fw-le-device" data-device="tablet" title="<?php echo esc_attr__( 'Tablet', 'fw' ); ?>">
						<span class="dashicons dashicons-tablet"></span>
					</button>
					<button type="button" class="fw-le-device" data-device="mobile" title="<?php echo esc_attr__( 'Mobile', 'fw' ); ?>">
						<span class="dashicons dashicons-smartphone"></span>
					</button>
				</div>
			</div>

			<div class="fw-le-toolbar__group fw-le-toolbar__group--right">
				<button type="button" id="fw-le-undo" class="fw-le-btn fw-le-btn--icon fw-le-btn--ghost" title="<?php echo esc_attr__( 'Undo (Ctrl+Z)', 'fw' ); ?>" disabled>
					<span class="dashicons dashicons-undo"></span>
				</button>
				<button type="button" id="fw-le-redo" class="fw-le-btn fw-le-btn--icon fw-le-btn--ghost" title="<?php echo esc_attr__( 'Redo (Ctrl+Y)', 'fw' ); ?>" disabled>
					<span class="dashicons dashicons-redo"></span>
				</button>
				<button type="button" id="fw-le-exit" class="fw-le-btn fw-le-btn--ghost">
					<span class="dashicons dashicons-no-alt"></span>
					<?php echo esc_html__( 'Exit', 'fw' ); ?>
				</button>
				<button type="button" id="fw-le-save" class="fw-le-btn fw-le-btn--primary" disabled>
					<span class="dashicons dashicons-saved"></span>
					<?php echo esc_html__( 'Save', 'fw' ); ?>
				</button>
			</div>
		</header>

		<main id="fw-le-canvas" class="fw-le-canvas">
			<iframe
				id="fw-le-frame"
				class="fw-le-frame"
				src="<?php echo esc_url( $fw_le_frame_url ); ?>"
				title="<?php echo esc_attr__( 'Live page canvas', 'fw' ); ?>"></iframe>
		</main>

	</div>

	<?php wp_footer(); ?>
</body>
</html>
