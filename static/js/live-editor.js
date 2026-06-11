/**
 * Live Editor — shell app (runs in the editor chrome document).
 *
 * Phase 0: handshake + Exit + working copy of the builder model.
 * Phase 1: reflects canvas selection in the toolbar.
 * Phase 2: opens fw.OptionsModal for the selected item; on change, re-renders
 *          just that item (AJAX) and swaps it into the canvas.
 *
 * Messages are trusted by SOURCE-WINDOW identity (the iframe), not a brittle
 * origin-string match, and sent with a permissive targetOrigin (both documents
 * are same-site by construction). Verbose tracing is on (DEBUG) while we
 * stabilise the handshake.
 */
/* global jQuery, _fwLiveEditor, fw */
( function ( $ ) {
	'use strict';

	var cfg   = window._fwLiveEditor || {};
	var NS    = 'fw-live-editor';
	var DEBUG = true;

	var LEAF_LABELS = {
		text_block:      'Text',
		special_heading: 'Heading',
		media_image:     'Image',
		button:          'Button',
		icon_box:        'Icon Box'
	};

	function titleize( slug ) {
		return String( slug || 'Element' )
			.replace( /[_-]+/g, ' ' )
			.replace( /\b\w/g, function ( c ) { return c.toUpperCase(); } );
	}

	function labelFor( node ) {
		if ( ! node ) { return 'Element'; }
		var t = node.type;
		if ( t === 'column' ) { return 'Column'; }
		if ( t === 'row' ) { return 'Row'; }
		if ( t === 'section' || /section$/.test( t ) ) { return 'Section'; }
		var sc = node.shortcode || t;
		return LEAF_LABELS[ sc ] || titleize( sc );
	}

	function tagFor( node ) {
		return node.shortcode || node.type;
	}

	function isContainer( node ) {
		var t = node.type;
		return t === 'column' || t === 'row' || t === 'section' || /section$/.test( t );
	}

	var fwLiveEditor = {
		config: cfg,

		model: ( function () {
			try {
				return JSON.parse( cfg.builder && cfg.builder.json ? cfg.builder.json : '[]' );
			} catch ( e ) {
				window.console && console.error( '[fw-le-shell] bad builder json', e );
				return [];
			}
		} )(),

		index: {},
		frameReady: false,
		dirty: false,
		modal: null,
		renderTimers: {},
		$: {},

		log: function () {
			if ( DEBUG && window.console && window.console.log ) {
				var a = Array.prototype.slice.call( arguments );
				a.unshift( '[fw-le-shell]' );
				console.log.apply( console, a );
			}
		},

		init: function () {
			this.$.frame  = $( '#fw-le-frame' );
			this.$.status = $( '#fw-le-status' );
			this.$.exit   = $( '#fw-le-exit' );
			this.$.save   = $( '#fw-le-save' );

			this.log( 'init', {
				hasFrame:        this.$.frame.length > 0,
				hasOptionsModal: typeof fw !== 'undefined' && !! ( fw && fw.OptionsModal ),
				items:           this.model.length,
				serverRuntime:   cfg.runtime,   // did PHP enqueue fw / fw-backend-options?
				fwScripts:       Array.prototype.map.call( document.scripts, function ( s ) { return s.src; } )
				                     .filter( function ( s ) { return /\/(fw|backend-options|fw-events)\b|fw\.js/.test( s ); } )
			} );

			this.$.exit.on( 'click', this.onExit.bind( this ) );
			this.$.save.on( 'click', this.onSave.bind( this ) );
			this.buildIndex( this.model, null );

			window.addEventListener( 'message', this.onMessage.bind( this ), false );

			this.setStatus( 'connecting', ( cfg.l10n && cfg.l10n.connecting ) || 'Connecting…' );
		},

		buildIndex: function ( items, parentId ) {
			if ( ! items || ! items.length ) { return; }
			for ( var i = 0; i < items.length; i++ ) {
				var it = items[ i ];
				if ( ! it || typeof it !== 'object' ) { continue; }
				var id = ( it.atts && it.atts.unique_id ) || it.unique_id;
				if ( id ) { this.index[ id ] = it; }
				if ( it._items && it._items.length ) {
					this.buildIndex( it._items, id || parentId );
				}
			}
		},

		/* ---- messaging -------------------------------------------------- */

		toFrame: function ( type, payload ) {
			var win = this.$.frame.length && this.$.frame[ 0 ].contentWindow;
			if ( win ) {
				this.log( 'send → frame', type );
				win.postMessage( { ns: NS, type: type, payload: payload }, '*' );
			} else {
				this.log( 'no iframe window to message' );
			}
		},

		onMessage: function ( ev ) {
			var data = ev.data;
			if ( ! data || data.ns !== NS ) { return; }

			var frameWin = this.$.frame.length && this.$.frame[ 0 ].contentWindow;
			if ( ev.source !== frameWin ) {
				this.log( 'drop message (unexpected source)', data.type, 'origin:', ev.origin );
				return;
			}

			this.log( 'recv', data.type, 'origin:', ev.origin );

			switch ( data.type ) {
				case 'frame-ready':
					this.onFrameReady();
					break;
				case 'select':
					this.onSelect( data.payload );
					break;
				case 'edit-request':
					this.onSelect( data.payload );
					this.openEditor( data.payload && data.payload.id );
					break;
				default:
					break;
			}
		},

		onFrameReady: function () {
			// Idempotent: the frame re-announces until it receives `init`, so we
			// may get several. Always (re)send the model; only flip state once.
			if ( ! this.frameReady ) {
				this.frameReady = true;
				this.log( 'frame ready' );
				this.setStatus( 'ready', ( cfg.l10n && cfg.l10n.ready ) || 'Ready' );
			}
			this.toFrame( 'init', { model: this.model } );
		},

		onSelect: function ( payload ) {
			var label = ( payload && payload.label ) || '';
			if ( ! this.$.selected ) {
				this.$.selected = $( '<span class="fw-le-selected" />' )
					.appendTo( '#fw-le-toolbar .fw-le-toolbar__group--left' );
			}
			this.$.selected.text( label ? ( '▸ ' + label ) : '' );
		},

		/* ---- editing (Phase 2) ----------------------------------------- */

		openEditor: function ( id ) {
			var node = id && this.index[ id ];
			if ( ! node ) { this.log( 'openEditor: unknown id', id ); return; }

			var self = this;
			this.log( 'openEditor', id, 'tag:', tagFor( node ) );

			// The options runtime (fw.OptionsModal) may load slightly late (e.g.
			// deferred scripts), so wait for it rather than bailing immediately.
			this.whenRuntimeReady( function ( ok ) {
				if ( ! ok ) {
					self.log( 'openEditor: options runtime UNAVAILABLE', {
						fw:    typeof fw,
						Modal: ( typeof fw !== 'undefined' && fw ) ? typeof fw.OptionsModal : 'n/a'
					} );
					window.alert( 'The options editor could not load. Please check the browser console.' );
					return;
				}

				self.fetchOptions( tagFor( node ), function ( options ) {
					if ( self.modal ) { try { self.modal.close(); } catch ( e ) {} }

					self.log( 'opening modal for', id, 'with', ( options || [] ).length, 'option groups' );
					self.modal = new fw.OptionsModal( {
						title:   labelFor( node ),
						options: options,
						values:  node.atts || {},
						size:    isContainer( node ) ? 'large' : 'medium'
					} );

					self.modal.on( 'change:values', function ( modal, values ) {
						node.atts = $.extend( {}, node.atts, values );
						self.markDirty();
						self.renderItem( id );
					} );

					self.modal.open();
				} );
			} );
		},

		/** Poll for fw.OptionsModal (handles deferred/late runtime). cb(true|false). */
		whenRuntimeReady: function ( cb ) {
			var tries = 0;
			( function check() {
				if ( typeof fw !== 'undefined' && fw && fw.OptionsModal ) { cb( true ); return; }
				if ( ++tries > 30 ) { cb( false ); return; } // ~3s
				window.setTimeout( check, 100 );
			} )();
		},

		fetchOptions: function ( tag, cb ) {
			this.ajax( cfg.actions.itemOptions, { tag: tag }, function ( resp ) {
				if ( resp && resp.success && resp.data && resp.data.options ) {
					cb( resp.data.options );
				} else {
					window.console && console.error( '[fw-le-shell] options load failed', resp );
				}
			} );
		},

		renderItem: function ( id ) {
			var node = this.index[ id ];
			if ( ! node ) { return; }
			var self = this;

			window.clearTimeout( this.renderTimers[ id ] );
			this.renderTimers[ id ] = window.setTimeout( function () {
				self.ajax( cfg.actions.renderItem, { item: JSON.stringify( node ) }, function ( resp ) {
					if ( resp && resp.success && resp.data && typeof resp.data.html === 'string' ) {
						self.toFrame( 'replace', { id: id, html: resp.data.html } );
					} else {
						window.console && console.error( '[fw-le-shell] render failed', resp );
					}
				} );
			}, 250 );
		},

		ajax: function ( action, data, cb ) {
			$.post( cfg.ajaxUrl, $.extend( {
				action:  action,
				post_id: cfg.postId,
				nonce:   cfg.nonce
			}, data ) ).done( cb ).fail( function ( xhr ) {
				window.console && console.error( '[fw-le-shell] ajax error', action, xhr && xhr.status );
			} );
		},

		markDirty: function () {
			this.dirty = true;
			this.$.save.prop( 'disabled', false );
			this.setStatus( 'unsaved', ( cfg.l10n && cfg.l10n.unsaved ) || 'Unsaved changes' );
		},

		onSave: function () {
			if ( ! this.dirty || this.saving ) { return; }
			this.saving = true;
			this.$.save.prop( 'disabled', true );
			this.setStatus( 'saving', ( cfg.l10n && cfg.l10n.saving ) || 'Saving…' );

			var self = this;
			this.ajax( cfg.actions.save, { json: JSON.stringify( this.model ) }, function ( resp ) {
				self.saving = false;
				if ( resp && resp.success ) {
					self.dirty = false;
					self.log( 'saved' );
					self.setStatus( 'ready', ( cfg.l10n && cfg.l10n.saved ) || 'Saved' );
				} else {
					window.console && console.error( '[fw-le-shell] save failed', resp );
					self.$.save.prop( 'disabled', false );
					self.setStatus( 'unsaved', ( cfg.l10n && cfg.l10n.saveError ) || 'Save failed' );
				}
			} );
		},

		onExit: function () {
			if ( this.dirty && ! window.confirm( ( cfg.l10n && cfg.l10n.confirmExit ) || 'You have unsaved changes. Leave anyway?' ) ) {
				return;
			}
			window.location.href = cfg.exitUrl || '/';
		},

		setStatus: function ( state, text ) {
			this.$.status.attr( 'data-state', state ).text( text );
		}
	};

	$( function () {
		fwLiveEditor.init();
	} );

	window.fwLiveEditor = fwLiveEditor;

} )( jQuery );
