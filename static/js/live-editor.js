/**
 * Live Editor — shell app (runs in the editor chrome document).
 *
 * Phase 0 responsibilities:
 *   - establish the postMessage handshake with the iframe canvas;
 *   - wire the Exit button;
 *   - hold the working copy of the builder model handed over from PHP.
 *
 * Later phases hang the selection panel, option editing and save flow off the
 * `fwLiveEditor` object created here. Kept dependency-light (jQuery only) on
 * purpose; the heavy editing UI (fw.OptionsModal etc.) arrives in Phase 2.
 */
/* global jQuery, _fwLiveEditor */
( function ( $ ) {
	'use strict';

	var cfg = window._fwLiveEditor || {};

	/**
	 * Namespace + tiny message protocol shared with the frame bridge.
	 * Every message is { ns: 'fw-live-editor', type: '…', payload: … }.
	 */
	var NS = 'fw-live-editor';

	var fwLiveEditor = {
		config: cfg,

		// Parsed working copy of the page-builder tree (single source of truth).
		model: ( function () {
			try {
				return JSON.parse( cfg.builder && cfg.builder.json ? cfg.builder.json : '[]' );
			} catch ( e ) {
				window.console && console.error( '[fw-live-editor] bad builder json', e );
				return [];
			}
		} )(),

		// True once the iframe canvas has reported it is ready to talk.
		frameReady: false,

		$: {},

		init: function () {
			this.$.frame  = $( '#fw-le-frame' );
			this.$.status = $( '#fw-le-status' );
			this.$.exit   = $( '#fw-le-exit' );
			this.$.save   = $( '#fw-le-save' );

			this.$.exit.on( 'click', this.onExit.bind( this ) );

			window.addEventListener( 'message', this.onMessage.bind( this ), false );

			this.setStatus( 'connecting', ( cfg.l10n && cfg.l10n.connecting ) || 'Connecting…' );
		},

		/** Post a namespaced message into the canvas iframe. */
		toFrame: function ( type, payload ) {
			var win = this.$.frame.length && this.$.frame[ 0 ].contentWindow;
			if ( win ) {
				win.postMessage( { ns: NS, type: type, payload: payload }, window.location.origin );
			}
		},

		onMessage: function ( ev ) {
			// Same-origin only; ignore anything that isn't our protocol.
			if ( ev.origin !== window.location.origin ) { return; }
			var data = ev.data;
			if ( ! data || data.ns !== NS ) { return; }

			switch ( data.type ) {
				case 'frame-ready':
					this.onFrameReady();
					break;
				default:
					// Reserved for Phase 1+ (select, hover, change…).
					break;
			}
		},

		onFrameReady: function () {
			this.frameReady = true;
			this.setStatus( 'ready', ( cfg.l10n && cfg.l10n.ready ) || 'Ready' );
			// Hand the model to the canvas so Phase 1 selection can map DOM → items.
			this.toFrame( 'init', { model: this.model } );
		},

		onExit: function () {
			window.location.href = cfg.exitUrl || '/';
		},

		setStatus: function ( state, text ) {
			this.$.status.attr( 'data-state', state ).text( text );
		}
	};

	$( function () {
		fwLiveEditor.init();
	} );

	// Expose for later phases / debugging.
	window.fwLiveEditor = fwLiveEditor;

} )( jQuery );
