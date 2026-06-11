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

	/** A fresh 32-hex builder unique_id (same shape the builder uses). */
	function generateUid() {
		if ( window.crypto && window.crypto.getRandomValues ) {
			var a = new Uint8Array( 16 ), s = '';
			window.crypto.getRandomValues( a );
			for ( var i = 0; i < a.length; i++ ) { s += ( '0' + a[ i ].toString( 16 ) ).slice( -2 ); }
			return s;
		}
		var h = '';
		for ( var j = 0; j < 32; j++ ) { h += Math.floor( Math.random() * 16 ).toString( 16 ); }
		return h;
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

		// index[id] = { node, siblings (the array containing node), parentId }.
		// `siblings` lets delete/duplicate splice in/out; rebuild after any
		// structural change so positions stay correct.
		buildIndex: function ( items, parentId ) {
			if ( ! items || ! items.length ) { return; }
			for ( var i = 0; i < items.length; i++ ) {
				var it = items[ i ];
				if ( ! it || typeof it !== 'object' ) { continue; }
				var id = ( it.atts && it.atts.unique_id ) || it.unique_id;
				if ( id ) { this.index[ id ] = { node: it, siblings: items, parentId: parentId }; }
				if ( it._items && it._items.length ) {
					this.buildIndex( it._items, id || parentId );
				}
			}
		},

		rebuildIndex: function () {
			this.index = {};
			this.buildIndex( this.model, null );
		},

		nodeOf: function ( id ) {
			var entry = id && this.index[ id ];
			return entry ? entry.node : null;
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
				case 'duplicate-request':
					this.duplicateItem( data.payload && data.payload.id );
					break;
				case 'delete-request':
					this.confirmDelete( data.payload );
					break;
				default:
					break;
			}
		},

		/* ---- styled confirm dialog ------------------------------------- */

		/** A lightweight, framework-styled confirm modal. cb runs on confirm. */
		confirm: function ( opts, cb ) {
			opts = opts || {};
			if ( ! this.$.confirm ) {
				this.$.confirm = $(
					'<div class="fw-le-confirm-backdrop" style="display:none">' +
						'<div class="fw-le-confirm" role="dialog" aria-modal="true">' +
							'<div class="fw-le-confirm__title"></div>' +
							'<div class="fw-le-confirm__msg"></div>' +
							'<div class="fw-le-confirm__actions">' +
								'<button type="button" class="fw-le-confirm__btn fw-le-confirm__btn--cancel"></button>' +
								'<button type="button" class="fw-le-confirm__btn fw-le-confirm__btn--ok"></button>' +
							'</div>' +
						'</div>' +
					'</div>'
				).appendTo( 'body' );
			}

			var $c   = this.$.confirm;
			var $ok  = $c.find( '.fw-le-confirm__btn--ok' );
			var $no  = $c.find( '.fw-le-confirm__btn--cancel' );

			$c.find( '.fw-le-confirm__title' ).text( opts.title || 'Are you sure?' );
			$c.find( '.fw-le-confirm__msg' ).text( opts.message || '' );
			$no.text( opts.cancelText || 'Cancel' );
			$ok.text( opts.confirmText || 'Confirm' ).toggleClass( 'fw-le-confirm__btn--danger', !! opts.danger );

			function close() {
				$c.hide();
				$ok.off( 'click' ); $no.off( 'click' ); $c.off( 'click' );
			}
			$ok.on( 'click', function () { close(); if ( cb ) { cb(); } } );
			$no.on( 'click', close );
			$c.on( 'click', function ( e ) { if ( e.target === $c[ 0 ] ) { close(); } } );

			$c.css( 'display', 'flex' );
			$ok.trigger( 'focus' );
		},

		confirmDelete: function ( payload ) {
			payload = payload || {};
			if ( ! payload.id ) { return; }
			var self  = this;
			var label = payload.label || 'item';
			this.confirm( {
				title:       'Delete ' + label + '?',
				message:     'This removes it from the page. You can Exit without saving to undo.',
				confirmText: 'Delete',
				danger:      true
			}, function () { self.deleteItem( payload.id ); } );
		},

		/* ---- structural ops (Phase A: duplicate / delete) -------------- */

		/** Push the current model to the frame so its selection index stays in sync. */
		syncFrameModel: function () {
			this.toFrame( 'sync-model', { model: this.model } );
		},

		/** Deep-clone a node, regenerating unique_id on it and every descendant. */
		cloneWithNewIds: function ( node ) {
			var clone = JSON.parse( JSON.stringify( node ) );
			( function regen( n ) {
				var nid = generateUid();
				if ( n.atts && typeof n.atts === 'object' ) { n.atts.unique_id = nid; }
				if ( Object.prototype.hasOwnProperty.call( n, 'unique_id' ) ) { n.unique_id = nid; }
				if ( n._items && n._items.length ) {
					for ( var i = 0; i < n._items.length; i++ ) { regen( n._items[ i ] ); }
				}
			} )( clone );
			return clone;
		},

		duplicateItem: function ( id ) {
			var entry = id && this.index[ id ];
			if ( ! entry ) { this.log( 'duplicate: unknown id', id ); return; }

			var siblings = entry.siblings;
			var pos = siblings.indexOf( entry.node );
			if ( pos < 0 ) { return; }

			var clone   = this.cloneWithNewIds( entry.node );
			var cloneId = ( clone.atts && clone.atts.unique_id ) || clone.unique_id;
			siblings.splice( pos + 1, 0, clone );

			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();

			var self = this;
			this.ajax( cfg.actions.renderItem, { item: JSON.stringify( clone ) }, function ( resp ) {
				if ( resp && resp.success && resp.data && typeof resp.data.html === 'string' ) {
					self.toFrame( 'insert-after', { afterId: id, id: cloneId, html: resp.data.html } );
				} else {
					window.console && console.error( '[fw-le-shell] duplicate render failed', resp );
				}
			} );
		},

		deleteItem: function ( id ) {
			var entry = id && this.index[ id ];
			if ( ! entry ) { this.log( 'delete: unknown id', id ); return; }

			var pos = entry.siblings.indexOf( entry.node );
			if ( pos < 0 ) { return; }
			entry.siblings.splice( pos, 1 );

			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
			this.toFrame( 'remove', { id: id } );
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
			var node = this.nodeOf( id );
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
			var node = this.nodeOf( id );
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
			var self = this;
			var leave = function () { window.location.href = cfg.exitUrl || '/'; };
			if ( this.dirty ) {
				this.confirm( {
					title:       'Discard unsaved changes?',
					message:     'You have unsaved edits on this page. Leaving will discard them.',
					confirmText: 'Leave',
					danger:      true
				}, leave );
				return;
			}
			leave();
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
