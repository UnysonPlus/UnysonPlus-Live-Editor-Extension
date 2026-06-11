/**
 * Live Editor — frame bridge + selection layer (runs INSIDE the iframe).
 *
 * Phase 1: map every `data-fw-item-id` wrapper to its model item, draw hover /
 * selected outlines, relay select / edit intents to the shell.
 * Phase 2: swap a re-rendered item's HTML back into the canvas.
 *
 * Handshake: the shell's message listener can attach LATER than this iframe
 * loads (it waits on the heavy options runtime), so a single `frame-ready` can
 * be missed. We therefore keep announcing on an interval until the shell replies
 * with `init`. Messages are trusted by SOURCE-WINDOW identity (parent/iframe),
 * not by a brittle origin-string match, and sent with a permissive targetOrigin
 * since both documents are same-site by construction.
 */
/* global jQuery, _fwLiveEditorFrame */
( function ( $ ) {
	'use strict';

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

	function labelFor( item ) {
		if ( ! item ) { return 'Element'; }
		var t = item.type;
		if ( t === 'column' ) { return 'Column'; }
		if ( t === 'row' ) { return 'Row'; }
		if ( t === 'section' || /section$/.test( t ) ) { return 'Section'; }
		var sc = item.shortcode || t;
		return LEAF_LABELS[ sc ] || titleize( sc );
	}

	var fwLiveEditorFrame = {
		config: window._fwLiveEditorFrame || {},

		model: null,
		index: {},
		els:   {},
		hoverEl:  null,
		activeEl: null,
		activeId: null,
		rafPending: false,
		announceTimer: null,
		announceTries: 0,
		started: false,

		log: function () {
			if ( DEBUG && window.console && window.console.log ) {
				var a = Array.prototype.slice.call( arguments );
				a.unshift( '[fw-le-frame]' );
				console.log.apply( console, a );
			}
		},

		init: function () {
			this.log( 'init', { postId: this.config.postId, href: window.location.href, hasParent: window.parent !== window } );

			window.addEventListener( 'message', this.onMessage.bind( this ), false );
			document.documentElement.classList.add( 'fw-le-frame-ready' );
			if ( document.body ) { document.body.classList.add( 'fw-live-editor-frame-active' ); }

			// Announce now, then keep announcing until the shell sends `init`.
			var self = this;
			this.announce();
			this.announceTimer = window.setInterval( function () {
				self.announceTries++;
				if ( self.announceTries >= 80 ) { // ~20s safety cap
					self.log( 'giving up announcing after', self.announceTries, 'tries' );
					window.clearInterval( self.announceTimer );
					self.announceTimer = null;
					return;
				}
				self.announce();
			}, 250 );
		},

		announce: function () {
			this.toShell( 'frame-ready', {
				postId: this.config.postId || 0,
				href:   window.location.href
			} );
		},

		/* ---- messaging -------------------------------------------------- */

		toShell: function ( type, payload ) {
			if ( window.parent && window.parent !== window ) {
				this.log( 'send → shell', type );
				window.parent.postMessage( { ns: NS, type: type, payload: payload }, '*' );
			} else {
				this.log( 'no parent window to message' );
			}
		},

		onMessage: function ( ev ) {
			var data = ev.data;
			if ( ! data || data.ns !== NS ) { return; }
			if ( ev.source !== window.parent ) {
				this.log( 'drop message (unexpected source)', data.type );
				return;
			}

			this.log( 'recv', data.type, 'origin:', ev.origin );

			if ( data.type === 'init' ) {
				if ( this.announceTimer ) {
					window.clearInterval( this.announceTimer );
					this.announceTimer = null;
				}
				if ( this.started ) { return; } // ignore duplicate inits
				this.started = true;

				this.model = ( data.payload && data.payload.model ) || [];
				this.buildIndex( this.model, null );
				this.buildOverlay();
				this.bindEvents();
				this.log( 'started; indexed', Object.keys( this.index ).length, 'items' );
			} else if ( data.type === 'replace' ) {
				this.replaceItem( data.payload );
			}
		},

		/** Swap a re-rendered item's HTML into the canvas, keeping it selected. */
		replaceItem: function ( payload ) {
			if ( ! payload || ! payload.id ) { return; }
			var old = document.querySelector( '[data-fw-item-id="' + payload.id + '"]' );
			if ( ! old ) { this.log( 'replace: element not found', payload.id ); return; }

			var tmp = document.createElement( 'div' );
			tmp.innerHTML = String( payload.html || '' ).trim();
			var nu = tmp.firstElementChild;
			if ( ! nu ) { this.log( 'replace: empty html' ); return; }

			old.parentNode.replaceChild( nu, old );

			if ( this.hoverEl === old ) { this.hoverEl = null; }
			if ( this.activeEl === old || this.activeId === payload.id ) {
				this.select( nu, payload.id );
			} else {
				this.reposition();
			}
		},

		/* ---- model index ------------------------------------------------ */

		buildIndex: function ( items, parentId ) {
			if ( ! items || ! items.length ) { return; }
			for ( var i = 0; i < items.length; i++ ) {
				var it = items[ i ];
				if ( ! it || typeof it !== 'object' ) { continue; }
				var id = ( it.atts && it.atts.unique_id ) || it.unique_id;
				if ( id ) {
					this.index[ id ] = {
						type:      it.type,
						shortcode: it.shortcode,
						label:     labelFor( it ),
						parentId:  parentId
					};
				}
				if ( it._items && it._items.length ) {
					this.buildIndex( it._items, id || parentId );
				}
			}
		},

		/* ---- overlay ---------------------------------------------------- */

		buildOverlay: function () {
			if ( this.els.root ) { return; }

			var root = document.createElement( 'div' );
			root.id = 'fw-le-overlay';
			root.setAttribute( 'aria-hidden', 'true' );
			root.innerHTML =
				'<div class="fw-le-box fw-le-box--hover"></div>' +
				'<div class="fw-le-box fw-le-box--active">' +
					'<div class="fw-le-tag">' +
						'<span class="fw-le-tag__label"></span>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-parent" title="Select parent">&#9650;</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-edit" title="Edit">&#9998;</button>' +
					'</div>' +
				'</div>';

			document.body.appendChild( root );

			this.els.root      = root;
			this.els.hoverBox  = root.querySelector( '.fw-le-box--hover' );
			this.els.activeBox = root.querySelector( '.fw-le-box--active' );
			this.els.activeLbl = root.querySelector( '.fw-le-tag__label' );

			var self = this;
			root.querySelector( '.fw-le-act-edit' ).addEventListener( 'click', function ( e ) {
				e.preventDefault(); e.stopPropagation();
				if ( self.activeId ) { self.toShell( 'edit-request', { id: self.activeId } ); }
			} );
			root.querySelector( '.fw-le-act-parent' ).addEventListener( 'click', function ( e ) {
				e.preventDefault(); e.stopPropagation();
				self.selectParent();
			} );
		},

		bindEvents: function () {
			var self = this;

			document.addEventListener( 'mouseover', function ( e ) {
				var hit = self.selectableFrom( e.target );
				self.setHover( hit ? hit.el : null );
			}, false );

			document.addEventListener( 'click', function ( e ) {
				if ( e.target.closest && e.target.closest( '#fw-le-overlay' ) ) { return; }
				var hit = self.selectableFrom( e.target );
				if ( hit ) {
					e.preventDefault();
					e.stopPropagation();
					self.select( hit.el, hit.id );
				}
			}, true );

			var reflow = function () {
				if ( self.rafPending ) { return; }
				self.rafPending = true;
				window.requestAnimationFrame( function () {
					self.rafPending = false;
					self.reposition();
				} );
			};
			window.addEventListener( 'scroll', reflow, true );
			window.addEventListener( 'resize', reflow, false );
		},

		selectableFrom: function ( el ) {
			var node = el;
			while ( node && node !== document.body ) {
				if ( node.nodeType === 1 && node.hasAttribute && node.hasAttribute( 'data-fw-item-id' ) ) {
					var id = node.getAttribute( 'data-fw-item-id' );
					if ( this.index[ id ] ) { return { el: node, id: id }; }
				}
				node = node.parentNode;
			}
			return null;
		},

		/* ---- selection / hover ----------------------------------------- */

		setHover: function ( el ) {
			this.hoverEl = el;
			if ( ! el || el === this.activeEl ) {
				this.els.hoverBox.style.display = 'none';
				return;
			}
			this.placeBox( this.els.hoverBox, el );
		},

		select: function ( el, id ) {
			this.activeEl = el;
			this.activeId = id;
			this.setHover( null );
			this.placeActive( el );
			this.els.activeLbl.textContent = ( this.index[ id ] && this.index[ id ].label ) || 'Element';
			this.toShell( 'select', {
				id:    id,
				type:  this.index[ id ] && this.index[ id ].type,
				label: this.index[ id ] && this.index[ id ].label
			} );
		},

		selectParent: function () {
			if ( ! this.activeId ) { return; }
			var parentId = this.index[ this.activeId ] && this.index[ this.activeId ].parentId;
			if ( ! parentId ) { return; }
			var el = document.querySelector( '[data-fw-item-id="' + parentId + '"]' );
			if ( el ) { this.select( el, parentId ); }
		},

		reposition: function () {
			if ( this.activeEl ) { this.placeActive( this.activeEl ); }
			if ( this.hoverEl && this.hoverEl !== this.activeEl ) {
				this.placeBox( this.els.hoverBox, this.hoverEl );
			}
		},

		placeActive: function ( el ) {
			var r = this.placeBox( this.els.activeBox, el );
			this.els.activeBox.setAttribute( 'data-tag-below', r.top < 28 ? '1' : '0' );
		},

		placeBox: function ( box, el ) {
			var r = el.getBoundingClientRect();
			box.style.display = 'block';
			box.style.top    = r.top + 'px';
			box.style.left   = r.left + 'px';
			box.style.width  = r.width + 'px';
			box.style.height = r.height + 'px';
			return r;
		}
	};

	$( function () {
		fwLiveEditorFrame.init();
	} );

	window.fwLiveEditorFrame = fwLiveEditorFrame;

} )( jQuery );
