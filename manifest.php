<?php if ( ! defined( 'FW' ) ) {
	die( 'Forbidden' );
}

$manifest = array();

$manifest['name']        = __( 'Live Page Editor', 'fw' );
$manifest['slug']        = 'unysonplus-live-editor';
$manifest['description'] = __(
	'Edit page-builder pages directly on the live front-end. Hover sections, columns and '
	. 'elements to select them and edit their options in place — an Avada-style visual builder '
	. 'layered on top of the existing Page Builder. Reached via the "Edit Live" admin-bar button.',
	'fw'
);

$manifest['version']    = '0.1.73';
$manifest['display']    = true;
$manifest['standalone'] = true;

// Repository Info — its own repo + auto-updater (a top-level extension, like Forms).
$manifest['github_update'] = 'UnysonPlus/UnysonPlus-Live-Editor-Extension';
$manifest['github_repo']   = 'https://github.com/UnysonPlus/UnysonPlus-Live-Editor-Extension';
$manifest['github_branch'] = 'master';

// Author Info
$manifest['author']     = 'UnysonPlus';
$manifest['author_uri'] = 'https://www.lastimosa.com.ph/unysonplus';

// Requirements — this extension only makes sense with the Page Builder it augments,
// so it hard-requires page-builder (which in turn pulls in builder + shortcodes).
$manifest['requirements'] = array(
	'framework'  => array(
		'min_version' => '2.1.19',
	),
	'extensions' => array(
		'page-builder' => array(),
	),
);

// Meta
$manifest['license']      = 'GPL-2.0-or-later';
$manifest['text_domain']  = 'fw';
$manifest['requires_php'] = '7.4';
$manifest['requires_wp']  = '5.8';
