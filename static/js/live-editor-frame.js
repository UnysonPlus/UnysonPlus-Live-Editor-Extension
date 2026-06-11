/**
 * Live Editor — frame bridge (runs INSIDE the iframe, on the live page).
 *
 * Phase 0 responsibilities:
 *   - announce readiness to the shell (postMessage handshake);
 *   - accept the initial model hand-off.
 *
 * Phase 1 grows this file into the selection layer: map each `data-fw-item-id`
 * wrapper in the rendered page to its model item, draw hover/selected outlines
 * over sections / columns / text, and relay select/edit intents to the shell.
 */
/* global jQuery, _fwLiveEditorFrame */
( function ( $ ) {
	'use strict';

	var NS = 'fw-live-editor';

	var fwLiveEditorFrame = {
		config: window._fwLiveEditorFrame || {},
		model: null,

		init: function () {
			window.addEventListener( 'message', this.onMessage.bind( this ), false );

			// Mark the document so edit-mode CSS can engage.
			document.documentElement.classList.add( 'fw-le-frame-ready' );

			// Tell the shell we're alive and listening.
			this.toShell( 'frame-ready', {
				postId: this.config.postId || 0,
				href:   window.location.href
			} );
		},

		/** Post a namespaced message up to the shell (parent) window. */
		toShell: function ( type, payload ) {
			if ( window.parent && window.parent !== window ) {
				window.parent.postMessage(
					{ ns: NS, type: type, payload: payload },
					window.location.origin
				);
			}
		},

		onMessage: function ( ev ) {
			if ( ev.origin !== window.location.origin ) { return; }
			var data = ev.data;
			if ( ! data || data.ns !== NS ) { return; }

			switch ( data.type ) {
				case 'init':
					this.model = data.payload && data.payload.model;
					// Phase 1: build the DOM ↔ model index + outline layer here.
					break;
				default:
					break;
			}
		}
	};

	$( function () {
		fwLiveEditorFrame.init();
	} );

	window.fwLiveEditorFrame = fwLiveEditorFrame;

} )( jQuery );
