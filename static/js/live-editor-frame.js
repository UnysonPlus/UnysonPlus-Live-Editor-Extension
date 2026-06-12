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

	function isContainerType( t ) {
		return t === 'column' || t === 'row' || t === 'section' || /section$/.test( t );
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
			} else if ( data.type === 'sync-model' ) {
				// Structural change in the shell: rebuild the selection index so
				// new ids are selectable and removed ids drop out. DOM is updated
				// separately via insert-after / remove.
				this.model = ( data.payload && data.payload.model ) || [];
				this.index = {};
				this.buildIndex( this.model, null );
			} else if ( data.type === 'insert-after' ) {
				this.insertAfter( data.payload );
			} else if ( data.type === 'remove' ) {
				this.removeItem( data.payload );
			}
		},

		/** Insert a duplicated item's HTML right after its source, then select it. */
		insertAfter: function ( payload ) {
			if ( ! payload || ! payload.afterId || ! payload.id ) { return; }
			var ref = document.querySelector( '[data-fw-item-id="' + payload.afterId + '"]' );
			if ( ! ref ) { this.log( 'insert-after: ref not found', payload.afterId ); return; }

			var tmp = document.createElement( 'div' );
			tmp.innerHTML = String( payload.html || '' ).trim();
			var nu = tmp.firstElementChild;
			if ( ! nu ) { return; }

			ref.parentNode.insertBefore( nu, ref.nextSibling );
			this.select( nu, payload.id );
		},

		/** Remove a deleted item's element + clear selection/hover if it was active. */
		removeItem: function ( payload ) {
			if ( ! payload || ! payload.id ) { return; }
			var el = document.querySelector( '[data-fw-item-id="' + payload.id + '"]' );
			if ( ! el ) { return; }
			if ( this.activeEl === el || this.activeId === payload.id ) { this.clearSelection(); }
			if ( this.hoverEl === el ) { this.hoverEl = null; this.els.hoverBox.style.display = 'none'; }
			el.parentNode.removeChild( el );
		},

		clearSelection: function () {
			this.activeEl = null;
			this.activeId = null;
			if ( this.els.activeBox ) { this.els.activeBox.style.display = 'none'; }
			this.toShell( 'select', { id: null, type: null, label: '' } );
		},

		/* ---- drag to reorder (Phase B) --------------------------------- */

		startDrag: function ( e ) {
			if ( ! this.activeEl ) { return; }
			e.preventDefault();
			e.stopPropagation();

			var self = this;
			var meta = this.index[ this.activeId ] || {};
			var d = this.drag = {
				el:             this.activeEl,
				id:             this.activeId,
				container:      this.activeEl.parentNode,
				isLeaf:         ! isContainerType( meta.type ),
				parentId:       meta.parentId || null,
				targetParentId: meta.parentId || null,
				startX:         e.clientX,
				startY:         e.clientY,
				started:        false,
				before:         null
			};
			d.move = function ( ev ) { self.onDragMove( ev ); };
			d.up   = function ( ev ) { self.onDragUp( ev ); };
			window.addEventListener( 'pointermove', d.move, true );
			window.addEventListener( 'pointerup', d.up, true );
			window.addEventListener( 'pointercancel', d.up, true );
		},

		beginDrag: function () {
			var d = this.drag;
			d.started = true;
			if ( ! d.isLeaf ) {
				// Containers (columns / sections) reorder among same-parent siblings.
				d.siblings = Array.prototype.filter.call( d.container.children, function ( c ) {
					return c.nodeType === 1 && c.hasAttribute( 'data-fw-item-id' );
				} );
				d.horizontal = this.detectHorizontal( d.siblings );
			}
			// Leaves are resolved against whichever column is under the pointer
			// (cross-column moves), so they need no precomputed sibling list.
			d.el.classList.add( 'fw-le-dragging' );
			this.els.activeBox.style.display = 'none';
			this.els.hoverBox.style.display = 'none';
			document.documentElement.classList.add( 'fw-le-drag-active' );
		},

		detectHorizontal: function ( siblings ) {
			var real = siblings.filter( function ( s ) { return true; } );
			if ( real.length < 2 ) {
				// Single item: fall back to the container's flex direction.
				var cs = window.getComputedStyle( this.drag.container );
				return cs.display.indexOf( 'flex' ) !== -1 && cs.flexDirection.indexOf( 'row' ) === 0;
			}
			var a = real[ 0 ].getBoundingClientRect(), b = real[ 1 ].getBoundingClientRect();
			return Math.abs( a.top - b.top ) < Math.min( a.height, b.height ) / 2;
		},

		onDragMove: function ( e ) {
			var d = this.drag;
			if ( ! d ) { return; }
			if ( ! d.started ) {
				if ( Math.abs( e.clientX - d.startX ) + Math.abs( e.clientY - d.startY ) < 5 ) { return; }
				this.beginDrag();
			}
			e.preventDefault();
			if ( d.isLeaf ) {
				this.computeLeafDrop( e.clientX, e.clientY );
			} else {
				d.before = this.computeDropTarget( e.clientX, e.clientY );
				this.positionDropline( d.before );
			}
		},

		/* Leaf drag: target any column under the pointer; insert among its leaves. */
		computeLeafDrop: function ( x, y ) {
			var d = this.drag;
			var under = document.elementFromPoint( x, y );
			var col = under ? this.nearestColumnEl( under ) : null;
			if ( ! col ) { d.targetParentId = null; this.els.dropline.style.display = 'none'; return; }

			var leaves = this.leafChildrenOf( col, d.el );
			var before = null;
			for ( var i = 0; i < leaves.length; i++ ) {
				var r = leaves[ i ].getBoundingClientRect();
				if ( y < r.top + r.height / 2 ) { before = leaves[ i ]; break; }
			}
			d.targetParentId = col.getAttribute( 'data-fw-item-id' );
			d.targetColEl = col;
			d.leaves = leaves;
			d.before = before;

			var line = this.els.dropline, cr = col.getBoundingClientRect();
			line.style.display = 'block';
			line.className = 'fw-le-dropline--h';
			line.style.left = cr.left + 'px';
			line.style.width = cr.width + 'px';
			line.style.height = '';
			line.style.top = ( before
				? before.getBoundingClientRect().top - 3
				: ( leaves.length ? leaves[ leaves.length - 1 ].getBoundingClientRect().bottom + 1 : cr.top + 6 )
			) + 'px';
		},

		nearestColumnEl: function ( el ) {
			var node = el;
			while ( node && node !== document.body ) {
				if ( node.nodeType === 1 && node.hasAttribute && node.hasAttribute( 'data-fw-item-id' ) ) {
					var meta = this.index[ node.getAttribute( 'data-fw-item-id' ) ];
					if ( meta && meta.type === 'column' ) { return node; }
				}
				node = node.parentNode;
			}
			return null;
		},

		/** Leaf elements whose nearest column ancestor is `colEl` (excludes one). */
		leafChildrenOf: function ( colEl, excludeEl ) {
			var all = colEl.querySelectorAll( '[data-fw-item-id]' ), out = [];
			for ( var i = 0; i < all.length; i++ ) {
				var el = all[ i ];
				if ( el === excludeEl ) { continue; }
				var meta = this.index[ el.getAttribute( 'data-fw-item-id' ) ];
				if ( ! meta || isContainerType( meta.type ) ) { continue; }
				if ( this.nearestColumnEl( el ) === colEl ) { out.push( el ); }
			}
			return out;
		},

		computeDropTarget: function ( x, y ) {
			var d = this.drag;
			var pos = d.horizontal ? x : y;
			for ( var i = 0; i < d.siblings.length; i++ ) {
				var s = d.siblings[ i ];
				if ( s === d.el ) { continue; }
				var r = s.getBoundingClientRect();
				var mid = d.horizontal ? ( r.left + r.width / 2 ) : ( r.top + r.height / 2 );
				if ( pos < mid ) { return s; }
			}
			return null; // past the last sibling → append
		},

		positionDropline: function ( before ) {
			var d = this.drag, line = this.els.dropline;
			var cr = d.container.getBoundingClientRect();
			line.style.display = 'block';
			line.className = d.horizontal ? 'fw-le-dropline--v' : 'fw-le-dropline--h';

			// Reference rect: the gap before `before`, or after the last non-dragged sibling.
			var refRect, atEnd = false;
			if ( before ) {
				refRect = before.getBoundingClientRect();
			} else {
				var last = null;
				for ( var i = d.siblings.length - 1; i >= 0; i-- ) {
					if ( d.siblings[ i ] !== d.el ) { last = d.siblings[ i ]; break; }
				}
				refRect = last ? last.getBoundingClientRect() : cr;
				atEnd = true;
			}

			if ( d.horizontal ) {
				line.style.top = cr.top + 'px';
				line.style.height = cr.height + 'px';
				line.style.width = '';
				line.style.left = ( atEnd ? refRect.right + 1 : refRect.left - 3 ) + 'px';
			} else {
				line.style.left = cr.left + 'px';
				line.style.width = cr.width + 'px';
				line.style.height = '';
				line.style.top = ( atEnd ? refRect.bottom + 1 : refRect.top - 3 ) + 'px';
			}
		},

		onDragUp: function () {
			var d = this.drag;
			if ( ! d ) { return; }
			window.removeEventListener( 'pointermove', d.move, true );
			window.removeEventListener( 'pointerup', d.up, true );
			window.removeEventListener( 'pointercancel', d.up, true );
			this.drag = null;

			this.els.dropline.style.display = 'none';
			document.documentElement.classList.remove( 'fw-le-drag-active' );

			if ( ! d.started ) { return; } // it was a click, not a drag

			d.el.classList.remove( 'fw-le-dragging' );

			if ( d.isLeaf ) {
				if ( ! d.targetParentId ) { this.select( d.el, d.id ); return; } // no valid column under pointer
				// Move the leaf element into the target column's content (works for
				// the same column AND a different one — the element is self-contained).
				var content;
				if ( d.before ) { content = d.before.parentNode; }
				else if ( d.leaves && d.leaves.length ) { content = d.leaves[ d.leaves.length - 1 ].parentNode; }
				else { content = d.targetColEl; } // empty column
				if ( d.before ) { content.insertBefore( d.el, d.before ); }
				else { content.appendChild( d.el ); }
			} else {
				d.container.insertBefore( d.el, d.before || null );
			}

			this.select( d.el, d.id );

			var beforeId = ( d.before && d.before.getAttribute ) ? d.before.getAttribute( 'data-fw-item-id' ) : null;
			this.toShell( 'move-item', { id: d.id, targetParentId: d.targetParentId, beforeId: beforeId } );
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

			var SVG = {
				drag:  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="6" cy="3.5" r="1.1" fill="currentColor"/><circle cx="10" cy="3.5" r="1.1" fill="currentColor"/><circle cx="6" cy="8" r="1.1" fill="currentColor"/><circle cx="10" cy="8" r="1.1" fill="currentColor"/><circle cx="6" cy="12.5" r="1.1" fill="currentColor"/><circle cx="10" cy="12.5" r="1.1" fill="currentColor"/></svg>',
				up:    '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
				copy:  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
				edit:  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M10.5 3l2.5 2.5-7 7-3 .5.5-3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
				trash: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
			};

			var root = document.createElement( 'div' );
			root.id = 'fw-le-overlay';
			root.setAttribute( 'aria-hidden', 'true' );
			root.innerHTML =
				'<div class="fw-le-box fw-le-box--hover"></div>' +
				'<div class="fw-le-box fw-le-box--active">' +
					'<div class="fw-le-tag">' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-drag" title="Drag to reorder">' + SVG.drag + '</button>' +
						'<span class="fw-le-tag__label"></span>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-parent" title="Select parent">' + SVG.up + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-duplicate" title="Duplicate">' + SVG.copy + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-edit" title="Edit">' + SVG.edit + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-tag__btn--danger fw-le-act-delete" title="Delete">' + SVG.trash + '</button>' +
					'</div>' +
				'</div>' +
				'<div id="fw-le-dropline" style="display:none"></div>';

			document.body.appendChild( root );

			this.els.root      = root;
			this.els.hoverBox  = root.querySelector( '.fw-le-box--hover' );
			this.els.activeBox = root.querySelector( '.fw-le-box--active' );
			this.els.activeLbl = root.querySelector( '.fw-le-tag__label' );
			this.els.dropline  = root.querySelector( '#fw-le-dropline' );

			var self = this;
			function on( sel, fn ) {
				root.querySelector( sel ).addEventListener( 'click', function ( e ) {
					e.preventDefault(); e.stopPropagation();
					fn();
				} );
			}
			// Drag handle starts a pointer drag (not a click).
			root.querySelector( '.fw-le-act-drag' ).addEventListener( 'pointerdown', function ( e ) {
				self.startDrag( e );
			} );
			on( '.fw-le-act-parent', function () { self.selectParent(); } );
			on( '.fw-le-act-duplicate', function () {
				if ( self.activeId ) { self.toShell( 'duplicate-request', { id: self.activeId } ); }
			} );
			on( '.fw-le-act-edit', function () {
				if ( self.activeId ) { self.toShell( 'edit-request', { id: self.activeId } ); }
			} );
			on( '.fw-le-act-delete', function () {
				if ( ! self.activeId ) { return; }
				var label = ( self.index[ self.activeId ] && self.index[ self.activeId ].label ) || 'item';
				// Confirmation is shown by the shell (styled dialog), not a native prompt.
				self.toShell( 'delete-request', { id: self.activeId, label: label } );
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
