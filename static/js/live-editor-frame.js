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

	// Restore non-passive listeners for interactive events on this iframe document.
	// Some hosts/extensions globally force addEventListener passive, which breaks
	// preventDefault() for clicks, drags and key handling. Mirrors the shell's
	// <head> guard (the iframe is a separate document, so it needs its own).
	( function () {
		var orig  = EventTarget.prototype.addEventListener;
		var force = { click: 1, dblclick: 1, mousedown: 1, mouseup: 1, submit: 1, keydown: 1, keyup: 1, pointerdown: 1, pointermove: 1, pointerup: 1, pointercancel: 1 };
		EventTarget.prototype.addEventListener = function ( type, listener, options ) {
			if ( force[ type ] ) {
				if ( options && typeof options === 'object' ) {
					if ( options.passive ) { options = Object.assign( {}, options, { passive: false } ); }
				} else {
					options = { capture: options === true, passive: false };
				}
			}
			return orig.call( this, type, listener, options );
		};
	} )();

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

	// Preview device → the responsive_hide ("Hide on") key that hides at that
	// breakpoint, plus a human label for the eye's tooltip.
	var DEVICE_HIDE  = { desktop: 'hide-md', tablet: 'hide-sm', mobile: 'hide-xs' };
	var DEVICE_LABEL = { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' };

	/** Is `meta` hidden on `device`? Reads the responsive_hide map ({hide-md:true}). */
	function hiddenOnDevice( meta, device ) {
		var rh = meta && meta.responsiveHide;
		return !! ( rh && rh[ DEVICE_HIDE[ device ] || DEVICE_HIDE.desktop ] );
	}

	// The page-builder 12-column grid: N twelfths → { width fraction id, the
	// frontend grid classes }. Mirrors framework/extensions/builder/config.php
	// `grid.columns` (the integer-twelfth widths; the odd 1/5 = sm-15 is omitted
	// so a drag snaps cleanly to 1…12).
	var GRID = {
		1:  { id: '1_12',  cls: 'fw-col-12 fw-col-sm-1' },
		2:  { id: '1_6',   cls: 'fw-col-12 fw-col-sm-2' },
		3:  { id: '1_4',   cls: 'fw-col-12 fw-col-sm-3' },
		4:  { id: '1_3',   cls: 'fw-col-12 fw-col-sm-4' },
		5:  { id: '5_12',  cls: 'fw-col-12 fw-col-sm-5' },
		6:  { id: '1_2',   cls: 'fw-col-12 fw-col-sm-6' },
		7:  { id: '7_12',  cls: 'fw-col-12 fw-col-sm-7' },
		8:  { id: '2_3',   cls: 'fw-col-12 fw-col-sm-8' },
		9:  { id: '3_4',   cls: 'fw-col-12 fw-col-sm-9' },
		10: { id: '5_6',   cls: 'fw-col-12 fw-col-sm-10' },
		11: { id: '11_12', cls: 'fw-col-12 fw-col-sm-11' },
		12: { id: '1_1',   cls: 'fw-col-12' }
	};

	/** Human label for a twelfths value — the reduced fraction the builder uses
	 *  (e.g. 6 → "1/2", 4 → "1/3", 8 → "2/3"), not the raw "/12" form. */
	function fracLabel( twelfths ) {
		var g = GRID[ twelfths ];
		return g ? g.id.replace( '_', '/' ) : ( twelfths + '/12' );
	}

	/** Read a column element's current width in twelfths from its grid classes. */
	function colTwelfths( el ) {
		var cn = el.className || '';
		var m  = cn.match( /fw-col-sm-(\d+)/ );
		if ( m ) {
			var n = parseInt( m[ 1 ], 10 );
			if ( n >= 1 && n <= 12 ) { return n; }
			if ( n === 15 ) { return 2; } // 1/5 ≈ rounds into the grid
		}
		return 12; // plain fw-col-12 (full) or fw-col (auto)
	}

	/** Replace a column element's grid classes with those for `twelfths` (1…12). */
	function applyColWidth( el, twelfths ) {
		var g = GRID[ twelfths ];
		if ( ! g ) { return; }
		var kept = ( el.className || '' ).split( /\s+/ ).filter( function ( c ) {
			return c && c !== 'fw-col-12' && ! /^fw-col(-sm-\w+)?$/.test( c );
		} );
		g.cls.split( /\s+/ ).forEach( function ( c ) { kept.push( c ); } );
		el.className = kept.join( ' ' );
	}

	var fwLiveEditorFrame = {
		config: window._fwLiveEditorFrame || {},

		model: null,
		index: {},
		els:   {},
		hoverEl:  null,
		activeEl: null,
		activeId: null,
		device:   'desktop',
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

			if ( data.type !== 'add-dragover' ) { this.log( 'recv', data.type, 'origin:', ev.origin ); } // high-frequency: skip

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
				this.markEmptyColumns();
				this.ensureAddSectionZone();
				this.ensureSectionAddColZones();
				this.refreshHiddenMarks();
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
				this.ensureAddSectionZone();
				this.ensureSectionAddColZones();
				this.refreshHiddenMarks();
			} else if ( data.type === 'insert-after' ) {
				this.insertAfter( data.payload );
			} else if ( data.type === 'insert-element' ) {
				this.insertElement( data.payload );
			} else if ( data.type === 'insert-section' ) {
				this.insertSection( data.payload );
			} else if ( data.type === 'render-page' ) {
				this.renderPage( data.payload );
			} else if ( data.type === 'set-device' ) {
				this.device = ( data.payload && data.payload.device ) || 'desktop';
				this.refreshHiddenMarks();
				this.updateTagHiddenState();
			} else if ( data.type === 'reflow' ) {
				this.reposition();
			} else if ( data.type === 'select-item' ) {
				this.focusItem( data.payload && data.payload.id, ! data.payload || data.payload.scroll !== false );
			} else if ( data.type === 'move-section' ) {
				this.moveSection( data.payload );
			} else if ( data.type === 'add-dragover' ) {
				this.pointerAddOver( data.payload );
			} else if ( data.type === 'add-drop' ) {
				this.pointerAddDrop( data.payload );
			} else if ( data.type === 'add-dragend' ) {
				this.addDropTarget = null;
				this.els.dropline.style.display = 'none';
			} else if ( data.type === 'remove' ) {
				this.removeItem( data.payload );
			}
		},

		/* Pointer-relayed drag-to-add (coords are iframe-viewport relative). */
		pointerAddOver: function ( p ) {
			if ( ! p ) { return; }
			var t = this.leafDropAt( p.x, p.y, null );
			this.addDropTarget = t;
			if ( t ) { this.showLeafDropline( t.col, t.before, t.leaves ); }
			else { this.els.dropline.style.display = 'none'; }
		},

		pointerAddDrop: function ( p ) {
			if ( ! p ) { return; }
			var t = this.leafDropAt( p.x, p.y, null );
			this.els.dropline.style.display = 'none';
			this.addDropTarget = null;
			this.log( 'add-drop', { tag: p.tag, col: t && t.col && t.col.getAttribute( 'data-fw-item-id' ) } );
			if ( ! t || ! t.col ) { return; }
			this.toShell( 'add-element', {
				tag:            p.tag,
				targetParentId: t.col.getAttribute( 'data-fw-item-id' ),
				beforeId:       t.before ? t.before.getAttribute( 'data-fw-item-id' ) : null
			} );
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
			this.ensureSelectable( nu );
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
			this.markEmptyColumns();
			this.ensureAddSectionZone();
		},

		clearSelection: function () {
			this.activeEl = null;
			this.activeId = null;
			if ( this.els.activeBox ) { this.els.activeBox.style.display = 'none'; }
			if ( this.els.resize ) { this.els.resize.style.display = 'none'; }
			this.toShell( 'select', { id: null, type: null, label: '' } );
		},

		/* ---- inline text editing (double-click) ------------------------ */

		onDblClick: function ( e ) {
			if ( this.editing ) { return; }
			var hit = this.selectableFrom( e.target );
			if ( ! hit ) { return; }
			var meta = this.index[ hit.id ];
			if ( ! meta ) { return; }

			if ( meta.shortcode === 'text_block' ) {
				this.enterInlineEdit( hit.el, hit.id ); // inline contenteditable
			} else if ( meta.shortcode === 'media_image' ) {
				this.toShell( 'edit-image', { id: hit.id } ); // open the media picker
			}
		},

		enterInlineEdit: function ( el, id ) {
			var self = this;
			this.editing = { el: el, id: id };

			this.els.activeBox.style.display = 'none';
			this.els.hoverBox.style.display = 'none';

			el.setAttribute( 'contenteditable', 'true' );
			el.classList.add( 'fw-le-editing' );
			el.focus();

			this.editing.onBlur = function () { self.exitInlineEdit(); };
			this.editing.onKey = function ( ev ) {
				if ( ev.key === 'Escape' ) { ev.preventDefault(); el.blur(); }
			};
			el.addEventListener( 'blur', this.editing.onBlur );
			el.addEventListener( 'keydown', this.editing.onKey );

			this.log( 'inline edit', id );
		},

		exitInlineEdit: function () {
			var ed = this.editing;
			if ( ! ed ) { return; }
			this.editing = null;

			ed.el.removeEventListener( 'blur', ed.onBlur );
			ed.el.removeEventListener( 'keydown', ed.onKey );
			ed.el.removeAttribute( 'contenteditable' );
			ed.el.classList.remove( 'fw-le-editing' );

			this.toShell( 'update-text', { id: ed.id, text: ed.el.innerHTML } );
			this.select( ed.el, ed.id );
		},

		/* ---- column resize (drag the right edge, 12-col grid) ---------- */

		startColResize: function ( e ) {
			if ( ! this.activeEl ) { return; }
			var meta = this.index[ this.activeId ] || {};
			if ( meta.type !== 'column' ) { return; }
			e.preventDefault();
			e.stopPropagation();

			var col = this.activeEl;
			var row = col.parentNode;

			// Adjacent column to the right (within the same row): it compensates so
			// the row stays balanced (a true divider drag). None → resize alone.
			var sib = col.nextElementSibling;
			while ( sib && ! ( sib.nodeType === 1 && sib.hasAttribute( 'data-fw-item-id' ) &&
				( this.index[ sib.getAttribute( 'data-fw-item-id' ) ] || {} ).type === 'column' ) ) {
				sib = sib.nextElementSibling;
			}

			var self = this;
			var r = this.colResize = {
				col:     col,
				id:      this.activeId,
				sib:     sib || null,
				sibId:   sib ? sib.getAttribute( 'data-fw-item-id' ) : null,
				startTw: colTwelfths( col ),
				rowRect: row.getBoundingClientRect(),
				colLeft: col.getBoundingClientRect().left,
				curTw:   0
			};
			r.combined = r.startTw + ( sib ? colTwelfths( sib ) : 0 );

			r.move = function ( ev ) { self.onColResizeMove( ev ); };
			r.up   = function ( ev ) { self.onColResizeUp( ev ); };
			window.addEventListener( 'pointermove', r.move, true );
			window.addEventListener( 'pointerup', r.up, true );
			window.addEventListener( 'pointercancel', r.up, true );

			document.documentElement.classList.add( 'fw-le-col-resizing' );
			this.els.resize.style.display = 'none';
			this.els.activeBox.style.display = 'none';
			this.els.hoverBox.style.display = 'none';
		},

		onColResizeMove: function ( e ) {
			var r = this.colResize;
			if ( ! r ) { return; }
			e.preventDefault();

			var tw = Math.round( ( e.clientX - r.colLeft ) / r.rowRect.width * 12 );

			if ( r.sib ) {
				tw = Math.max( 1, Math.min( r.combined - 1, tw ) );
				r.curTw    = tw;
				r.curSibTw = r.combined - tw;
				applyColWidth( r.col, r.curTw );
				applyColWidth( r.sib, r.curSibTw );
			} else {
				tw = Math.max( 1, Math.min( 12, tw ) );
				r.curTw = tw;
				applyColWidth( r.col, r.curTw );
			}

			this.showResizeTip( e.clientX, e.clientY, r );
		},

		onColResizeUp: function () {
			var r = this.colResize;
			if ( ! r ) { return; }
			window.removeEventListener( 'pointermove', r.move, true );
			window.removeEventListener( 'pointerup', r.up, true );
			window.removeEventListener( 'pointercancel', r.up, true );
			this.colResize = null;

			document.documentElement.classList.remove( 'fw-le-col-resizing' );
			if ( this.els.resizeTip ) { this.els.resizeTip.style.display = 'none'; }

			// Commit only on a real change.
			if ( r.curTw && r.curTw !== r.startTw && GRID[ r.curTw ] ) {
				var payload = { id: r.id, width: GRID[ r.curTw ].id };
				if ( r.sib && r.curSibTw && GRID[ r.curSibTw ] ) {
					payload.siblingId    = r.sibId;
					payload.siblingWidth = GRID[ r.curSibTw ].id;
				}
				this.toShell( 'resize-column', payload );
			}

			this.select( r.col, r.id ); // redraw overlay + reposition grip
		},

		showResizeTip: function ( x, y, r ) {
			var tip = this.els.resizeTip;
			if ( ! tip ) { return; }
			tip.style.display = 'block';
			tip.style.left = ( x + 14 ) + 'px';
			tip.style.top  = ( y - 10 ) + 'px';
			tip.textContent = r.sib
				? ( fracLabel( r.curTw ) + '  ·  ' + fracLabel( r.curSibTw ) )
				: fracLabel( r.curTw );
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
				isColumn:       meta.type === 'column',
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

			var rect = d.el.getBoundingClientRect();
			d.cloneBaseLeft = rect.left;
			d.cloneBaseTop  = rect.top;
			d.flipped = [];

			// A lifted clone follows the cursor (by delta from the grab point); the
			// original element becomes a faded placeholder gap that slides to the drop
			// position while siblings FLIP-animate out of the way.
			var clone = d.clone = d.el.cloneNode( true );
			clone.removeAttribute( 'data-fw-item-id' );
			var inner = clone.querySelectorAll( '[data-fw-item-id]' );
			for ( var i = 0; i < inner.length; i++ ) { inner[ i ].removeAttribute( 'data-fw-item-id' ); }
			clone.classList.add( 'fw-le-drag-clone' );
			clone.style.cssText = 'position:fixed; margin:0; left:' + rect.left + 'px; top:' + rect.top +
				'px; width:' + rect.width + 'px; pointer-events:none; z-index:2147483002;';
			document.body.appendChild( clone );

			d.el.classList.add( 'fw-le-dragging' );        // pointer-events:none for elementFromPoint
			d.el.classList.add( 'fw-le-drag-placeholder' ); // styled as a gap
			d.el.style.height = rect.height + 'px';        // keep the gap's size when content hides

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

			// Clone follows the cursor.
			d.clone.style.left = ( d.cloneBaseLeft + ( e.clientX - d.startX ) ) + 'px';
			d.clone.style.top  = ( d.cloneBaseTop + ( e.clientY - d.startY ) ) + 'px';

			// Resolve where the placeholder should sit, then slide it there.
			var t = null;
			if ( d.isLeaf ) {
				var lt = this.leafDropAt( e.clientX, e.clientY, d.el );
				if ( lt && lt.col ) {
					var parent = lt.before ? lt.before.parentNode
						: ( lt.leaves.length ? lt.leaves[ lt.leaves.length - 1 ].parentNode : lt.col );
					t = { parent: parent, before: lt.before };
				}
			} else if ( d.isColumn ) {
				var ct = this.columnDropAt( e.clientX, e.clientY, d.el );
				if ( ct ) { t = { parent: ct.rowEl, before: ct.before }; }
			} else {
				t = this.sectionDropAt( e.clientY, d.el );
			}
			if ( t && t.parent ) { this.reorderPlaceholder( t.parent, t.before ); }
		},

		/** Slide the placeholder into { parent, before }, FLIP-animating the
		 *  source + target containers' children so they move out of the way. */
		reorderPlaceholder: function ( parent, before ) {
			var d = this.drag;
			if ( before === d.el ) { before = null; }
			if ( d.el.parentNode === parent && d.el.nextElementSibling === ( before || null ) ) { return; }

			var affected = [];
			var add = function ( p ) {
				if ( ! p ) { return; }
				for ( var i = 0; i < p.children.length; i++ ) {
					if ( affected.indexOf( p.children[ i ] ) === -1 ) { affected.push( p.children[ i ] ); }
				}
			};
			add( d.el.parentNode );
			add( parent );

			var firsts = affected.map( function ( el ) { return { el: el, r: el.getBoundingClientRect() }; } );
			parent.insertBefore( d.el, before || null );

			var flipped = d.flipped;
			firsts.forEach( function ( f ) {
				var n = f.el.getBoundingClientRect();
				var dx = f.r.left - n.left, dy = f.r.top - n.top;
				if ( ! dx && ! dy ) { return; }
				if ( flipped.indexOf( f.el ) === -1 ) { flipped.push( f.el ); }
				f.el.style.transition = 'none';
				f.el.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
				window.requestAnimationFrame( function () {
					f.el.style.transition = 'transform .16s ease';
					f.el.style.transform = '';
				} );
			} );
		},

		/** Section drop target: the top-level section the cursor is above (or end). */
		sectionDropAt: function ( y, excludeEl ) {
			var container = excludeEl.parentNode;
			var before = null, c = container.firstElementChild;
			while ( c ) {
				if ( c !== excludeEl && c.hasAttribute( 'data-fw-item-id' ) &&
					/section$/.test( ( this.index[ c.getAttribute( 'data-fw-item-id' ) ] || {} ).type || '' ) ) {
					var r = c.getBoundingClientRect();
					if ( y < r.top + r.height / 2 ) { before = c; break; }
				}
				c = c.nextElementSibling;
			}
			// Past the last section → keep it before the "+ Add Section" bar.
			if ( ! before && this.els.addZone && this.els.addZone.parentNode === container ) {
				before = this.els.addZone;
			}
			return { parent: container, before: before };
		},

		/** Id of the next sibling item of the given kind after `el` (or null). */
		nextItemId: function ( el, kind ) {
			var n = el.nextElementSibling;
			while ( n ) {
				if ( n.hasAttribute( 'data-fw-item-id' ) ) {
					var meta = this.index[ n.getAttribute( 'data-fw-item-id' ) ];
					if ( meta ) {
						var ok = kind === 'leaf' ? ! isContainerType( meta.type )
							: kind === 'column' ? meta.type === 'column'
							: /section$/.test( meta.type || '' );
						if ( ok ) { return n.getAttribute( 'data-fw-item-id' ); }
					}
				}
				n = n.nextElementSibling;
			}
			return null;
		},

		/* Leaf drag: target any column under the pointer; insert among its leaves. */
		computeLeafDrop: function ( x, y ) {
			var d = this.drag;
			var t = this.leafDropAt( x, y, d.el );
			if ( ! t ) { d.targetParentId = null; this.els.dropline.style.display = 'none'; return; }
			d.targetParentId = t.col.getAttribute( 'data-fw-item-id' );
			d.targetColEl    = t.col;
			d.leaves         = t.leaves;
			d.before         = t.before;
			this.showLeafDropline( t.col, t.before, t.leaves );
		},

		/** Resolve { col, before, leaves } for a point — shared by pointer-drag
		 *  reordering and native drag-to-add. Returns null if not over a column. */
		leafDropAt: function ( x, y, excludeEl ) {
			var under = document.elementFromPoint( x, y );
			var col = under ? this.nearestColumnEl( under ) : null;
			if ( ! col ) { return null; }
			var leaves = this.leafChildrenOf( col, excludeEl || null );
			var before = null;
			for ( var i = 0; i < leaves.length; i++ ) {
				var r = leaves[ i ].getBoundingClientRect();
				if ( y < r.top + r.height / 2 ) { before = leaves[ i ]; break; }
			}
			return { col: col, before: before, leaves: leaves };
		},

		showLeafDropline: function ( col, before, leaves ) {
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

		/* Column drag: target any section under the pointer; insert among its
		 * columns (so a column can move within OR across sections). */
		computeColumnDrop: function ( x, y ) {
			var d = this.drag;
			var t = this.columnDropAt( x, y, d.el );
			if ( ! t ) { d.targetSectionId = null; this.els.dropline.style.display = 'none'; return; }
			d.targetSectionId = t.sectionEl.getAttribute( 'data-fw-item-id' );
			d.targetRowEl     = t.rowEl;
			d.before          = t.before;
			this.showColumnDropline( t.rowEl, t.before, d.el );
		},

		/** Resolve { sectionEl, rowEl, before } for a point — the section under the
		 *  pointer, the row to drop into, and the column to insert before (null =
		 *  append). Returns null if not over a section. */
		columnDropAt: function ( x, y, excludeEl ) {
			var under = document.elementFromPoint( x, y );
			if ( ! under ) { return null; }
			var sectionEl = this.nearestSectionEl( under );
			if ( ! sectionEl ) { return null; }

			var colUnder = this.nearestColumnEl( under );
			if ( colUnder && colUnder !== excludeEl ) {
				var r = colUnder.getBoundingClientRect();
				var before = ( x < r.left + r.width / 2 ) ? colUnder : this.nextColumnEl( colUnder, excludeEl );
				return { sectionEl: sectionEl, rowEl: colUnder.parentNode, before: before };
			}

			// Over the section but not a column → append into its last row.
			var rows = sectionEl.querySelectorAll( '.fw-row' );
			var rowEl = rows.length ? rows[ rows.length - 1 ] : ( sectionEl.querySelector( '.fw-container' ) || sectionEl );
			return { sectionEl: sectionEl, rowEl: rowEl, before: null };
		},

		/** Nearest section-like ancestor element of `el` (or null). */
		nearestSectionEl: function ( el ) {
			var node = el;
			while ( node && node !== document.body ) {
				if ( node.nodeType === 1 && node.hasAttribute && node.hasAttribute( 'data-fw-item-id' ) ) {
					var meta = this.index[ node.getAttribute( 'data-fw-item-id' ) ];
					if ( meta && /section$/.test( meta.type || '' ) ) { return node; }
				}
				node = node.parentNode;
			}
			return null;
		},

		/** Next column sibling after `colEl` (skipping the dragged element). */
		nextColumnEl: function ( colEl, excludeEl ) {
			var n = colEl.nextElementSibling;
			while ( n ) {
				if ( n !== excludeEl && n.hasAttribute( 'data-fw-item-id' ) &&
					( this.index[ n.getAttribute( 'data-fw-item-id' ) ] || {} ).type === 'column' ) { return n; }
				n = n.nextElementSibling;
			}
			return null;
		},

		showColumnDropline: function ( rowEl, before, excludeEl ) {
			var line = this.els.dropline, rr = rowEl.getBoundingClientRect();
			line.style.display = 'block';
			line.className = 'fw-le-dropline--v';
			line.style.width = '';
			line.style.top = rr.top + 'px';
			line.style.height = rr.height + 'px';

			var x;
			if ( before ) {
				x = before.getBoundingClientRect().left - 2;
			} else {
				var last = null, c = rowEl.firstElementChild;
				while ( c ) {
					if ( c !== excludeEl && c.hasAttribute( 'data-fw-item-id' ) &&
						( this.index[ c.getAttribute( 'data-fw-item-id' ) ] || {} ).type === 'column' ) { last = c; }
					c = c.nextElementSibling;
				}
				x = last ? last.getBoundingClientRect().right + 1 : rr.left + 4;
			}
			line.style.left = x + 'px';
		},

		/* ---- drag-to-add from the element panel (native DnD) ----------- */

		isElementDrag: function ( e ) {
			return !! ( e.dataTransfer &&
				Array.prototype.indexOf.call( e.dataTransfer.types || [], 'application/x-fw-element' ) !== -1 );
		},

		onAddDragEnter: function ( e ) {
			if ( ! this.isElementDrag( e ) ) { return; }
			e.preventDefault();
			if ( e.dataTransfer ) { e.dataTransfer.dropEffect = 'copy'; }
		},

		onAddDragOver: function ( e ) {
			if ( ! this.isElementDrag( e ) ) { return; }
			e.preventDefault();
			if ( e.dataTransfer ) { e.dataTransfer.dropEffect = 'copy'; }
			var t = this.leafDropAt( e.clientX, e.clientY, null );
			this.addDropTarget = t;
			if ( t ) { this.showLeafDropline( t.col, t.before, t.leaves ); }
			else { this.els.dropline.style.display = 'none'; }
		},

		onAddDrop: function ( e ) {
			if ( ! this.isElementDrag( e ) ) { return; }
			e.preventDefault();
			var tag = e.dataTransfer.getData( 'application/x-fw-element' ) || e.dataTransfer.getData( 'text/plain' );
			this.els.dropline.style.display = 'none';
			var t = this.addDropTarget;
			this.addDropTarget = null;
			if ( ! tag || ! t || ! t.col ) { return; }
			this.toShell( 'add-element', {
				tag:            tag,
				targetParentId: t.col.getAttribute( 'data-fw-item-id' ),
				beforeId:       t.before ? t.before.getAttribute( 'data-fw-item-id' ) : null
			} );
		},

		onAddDragLeave: function ( e ) {
			if ( e.relatedTarget === null ) { this.els.dropline.style.display = 'none'; }
		},

		/** Insert a newly-created element's HTML into the target column + select it. */
		insertElement: function ( payload ) {
			if ( ! payload || ! payload.targetParentId ) { return; }
			var col = document.querySelector( '[data-fw-item-id="' + payload.targetParentId + '"]' );
			if ( ! col ) { this.log( 'insert-element: target column not found' ); return; }

			var tmp = document.createElement( 'div' );
			tmp.innerHTML = String( payload.html || '' ).trim();
			var nu = tmp.firstElementChild;
			if ( ! nu ) { return; }

			var beforeEl = payload.beforeId ? document.querySelector( '[data-fw-item-id="' + payload.beforeId + '"]' ) : null;
			if ( beforeEl && beforeEl.parentNode ) {
				beforeEl.parentNode.insertBefore( nu, beforeEl );
			} else {
				var leaves = this.leafChildrenOf( col, null );
				var content = leaves.length ? leaves[ leaves.length - 1 ].parentNode : col;
				content.appendChild( nu );
			}
			this.ensureSelectable( nu );
			this.markEmptyColumns();
			this.select( nu, payload.id );
		},

		/** Insert a freshly-added section at the page root, then select it. The
		 *  shell already sent `sync-model` (so the new section + column ids are in
		 *  the index); here we only place the DOM. afterId is the previous last
		 *  top-level item — we drop after it; on an empty page we append to the
		 *  page-builder content container. */
		insertSection: function ( payload ) {
			if ( ! payload || ! payload.id || ! payload.html ) { return; }

			var tmp = document.createElement( 'div' );
			tmp.innerHTML = String( payload.html || '' ).trim();
			var nu = tmp.firstElementChild;
			if ( ! nu ) { return; }

			var placed = false;
			if ( payload.afterId ) {
				var after = document.querySelector( '[data-fw-item-id="' + payload.afterId + '"]' );
				if ( after && after.parentNode ) {
					after.parentNode.insertBefore( nu, after.nextSibling );
					placed = true;
				}
			}
			if ( ! placed ) {
				var container = this.findSectionsContainer();
				if ( container ) { container.appendChild( nu ); placed = true; }
			}
			if ( ! placed ) { return; }

			this.ensureSelectable( nu );
			this.markEmptyColumns( nu );
			this.ensureAddSectionZone();
			this.ensureSectionAddColZones();
			this.select( nu, payload.id );
			nu.scrollIntoView( { behavior: 'smooth', block: 'center' } );
		},

		/** Select an item by id; optionally scroll it into view (navigator jumps
		 *  scroll, breadcrumb crumbs don't — the ancestor is already on screen). */
		focusItem: function ( id, scroll ) {
			if ( ! id ) { return; }
			var el = document.querySelector( '[data-fw-item-id="' + id + '"]' );
			if ( ! el ) { return; }
			this.select( el, id );
			if ( scroll ) { el.scrollIntoView( { behavior: 'smooth', block: 'start' } ); }
		},

		/** Move a section element to sit before `beforeId` (or to the end, before the
		 *  add-section zone) — the DOM half of a navigator reorder. */
		moveSection: function ( payload ) {
			if ( ! payload || ! payload.id ) { return; }
			var el = document.querySelector( '[data-fw-item-id="' + payload.id + '"]' );
			if ( ! el ) { return; }

			var ref = payload.beforeId ? document.querySelector( '[data-fw-item-id="' + payload.beforeId + '"]' ) : null;
			if ( ref && ref.parentNode ) {
				ref.parentNode.insertBefore( el, ref );
			} else {
				var container = this.findSectionsContainer();
				if ( container ) {
					if ( this.els.addZone && this.els.addZone.parentNode === container ) {
						container.insertBefore( el, this.els.addZone );
					} else {
						container.appendChild( el );
					}
				}
			}
			this.ensureAddSectionZone();
			if ( this.activeId === payload.id ) { this.reposition(); }
		},

		/** Replace the entire builder content in the canvas with freshly-rendered
		 *  HTML (used by undo/redo). Removes the current top-level sections + the
		 *  editor's add-section zone, inserts the new sections in their place, and
		 *  re-runs the editor decorations. The shell sends `sync-model` first, so
		 *  the index already matches the new HTML's item ids. */
		renderPage: function ( payload ) {
			if ( ! payload || typeof payload.html !== 'string' ) { return; }
			var container = this.findSectionsContainer();
			if ( ! container ) { this.log( 'render-page: no container' ); return; }

			var tmp = document.createElement( 'div' );
			tmp.innerHTML = payload.html.trim();
			var newNodes = Array.prototype.slice.call( tmp.children );

			// Insertion anchor = whatever currently precedes the first section, so
			// new content lands in the same spot even if the container holds more
			// than just builder sections.
			var kids = Array.prototype.slice.call( container.children );
			var firstSection = null;
			for ( var i = 0; i < kids.length; i++ ) {
				if ( kids[ i ].hasAttribute && kids[ i ].hasAttribute( 'data-fw-item-id' ) ) { firstSection = kids[ i ]; break; }
			}
			var anchorPrev = firstSection ? firstSection.previousSibling : null;

			// Remove the old sections + the editor's add-section zone.
			kids.forEach( function ( c ) {
				if ( c.classList && c.classList.contains( 'fw-le-add-section-zone' ) ) { c.parentNode.removeChild( c ); return; }
				if ( c.hasAttribute && c.hasAttribute( 'data-fw-item-id' ) ) { c.parentNode.removeChild( c ); }
			} );

			this.els.addZone = null;
			this.clearSelection();
			this.hoverEl = null;
			if ( this.els.hoverBox ) { this.els.hoverBox.style.display = 'none'; }

			var ref = anchorPrev ? anchorPrev.nextSibling : container.firstChild;
			newNodes.forEach( function ( n ) { container.insertBefore( n, ref ); } );

			this.markEmptyColumns();
			this.ensureSectionAddColZones();
			this.ensureAddSectionZone();
			this.refreshHiddenMarks();
		},

		/** The element that holds top-level sections. Prefer the page-builder
		 *  content wrapper; else fall back to the parent of any indexed top-level
		 *  section already in the DOM. */
		findSectionsContainer: function () {
			var pbc = document.querySelector( '.fw-page-builder-content' );
			if ( pbc ) { return pbc; }
			var firstSection = document.querySelector( '[data-fw-item-id]' );
			if ( firstSection ) { return firstSection.parentNode; }
			// Blank builder page: fall back to the post content wrapper.
			var ec = document.querySelector( '.entry-content, .fw-page-content, article .entry-content, main' );
			return ec || document.body || null;
		},

		/** A persistent "+ Add Section" bar pinned after the last section (and an
		 *  "Add your first section" empty-state when the page has no sections).
		 *  Clicking it asks the shell to open the structure picker. Kept last in the
		 *  sections container and re-synced after every structural change. */
		ensureAddSectionZone: function () {
			var container = this.findSectionsContainer();
			if ( ! container ) { return; }

			var l = ( this.config && this.config.l10n ) || {};
			var zone = this.els.addZone;
			if ( ! zone ) {
				var self = this;
				zone = this.els.addZone = document.createElement( 'div' );
				zone.className = 'fw-le-add-section-zone';
				zone.innerHTML = '<button type="button" class="fw-le-add-section-btn">' +
					'<span class="fw-le-add-section-plus">+</span><em></em></button>';
				zone.querySelector( '.fw-le-add-section-btn' ).addEventListener( 'click', function ( e ) {
					e.preventDefault();
					e.stopPropagation();
					self.toShell( 'open-structure-picker', {} );
				} );
			}

			var empty = ! this.model || this.model.length === 0;
			zone.classList.toggle( 'fw-le-add-section-zone--empty', empty );
			zone.querySelector( 'em' ).textContent = empty
				? ( l.firstSection || 'Add your first section' )
				: ( l.addSectionHere || 'Add Section' );

			container.appendChild( zone ); // always keep it last
		},

		/** Inject a "+ Add Column" bar at the bottom of each section (below its
		 *  columns), re-created after every section re-render. Clicking it asks the
		 *  shell to open the column-width picker for that section. */
		ensureSectionAddColZones: function () {
			var self = this;
			var all = document.querySelectorAll( '[data-fw-item-id]' );
			for ( var i = 0; i < all.length; i++ ) {
				var el = all[ i ];
				var meta = this.index[ el.getAttribute( 'data-fw-item-id' ) ];
				if ( ! meta || ! /section$/.test( meta.type || '' ) ) { continue; }
				if ( el.querySelector( ':scope > .fw-le-addcol-zone' ) ) { continue; }

				var sid  = el.getAttribute( 'data-fw-item-id' );
				var zone = document.createElement( 'div' );
				zone.className = 'fw-le-addcol-zone';
				zone.innerHTML = '<button type="button" class="fw-le-addcol-btn">' +
					'<span class="fw-le-addcol-plus">+</span> ' +
					( ( ( this.config && this.config.l10n ) || {} ).addColumn || 'Add Column' ) + '</button>';
				zone.querySelector( 'button' ).addEventListener( 'click', ( function ( sectionId ) {
					return function ( e ) {
						e.preventDefault();
						e.stopPropagation();
						self.toShell( 'open-column-picker', { id: sectionId } );
					};
				} )( sid ) );
				el.appendChild( zone );
			}
		},

		/** Tag columns with no leaf children so CSS can render them as a visible,
		 *  labelled drop zone (an empty new section is otherwise an unusable sliver). */
		markEmptyColumns: function ( scope ) {
			var root = scope || document;
			var cols = root.querySelectorAll ? root.querySelectorAll( '[data-fw-item-id]' ) : [];
			for ( var i = 0; i < cols.length; i++ ) {
				var el = cols[ i ];
				var meta = this.index[ el.getAttribute( 'data-fw-item-id' ) ];
				if ( ! meta || meta.type !== 'column' ) { continue; }
				if ( this.leafChildrenOf( el, null ).length === 0 ) { el.classList.add( 'fw-le-empty-col' ); }
				else { el.classList.remove( 'fw-le-empty-col' ); }
			}
		},

		/** Inline / empty elements (e.g. an icon with no glyph) can render to a
		 *  0×0 box that's impossible to hover or reselect. Force such collapsed
		 *  items to a clickable block so the editor can always reach them. */
		ensureSelectable: function ( el ) {
			if ( ! el || ! el.getBoundingClientRect ) { return; }
			var r = el.getBoundingClientRect();
			if ( r.height < 8 && r.width < 8 ) { el.classList.add( 'fw-le-collapsed' ); }
			else { el.classList.remove( 'fw-le-collapsed' ); }
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

			// Tear down the clone, un-placeholder the element, clear FLIP transforms.
			if ( d.clone && d.clone.parentNode ) { d.clone.parentNode.removeChild( d.clone ); }
			d.el.classList.remove( 'fw-le-dragging', 'fw-le-drag-placeholder' );
			d.el.style.height = '';
			if ( d.flipped ) {
				d.flipped.forEach( function ( el ) { el.style.transition = ''; el.style.transform = ''; } );
			}

			// The placeholder (d.el) is already in its final slot — commit it. Read
			// the new container + the next same-kind sibling straight from the DOM.
			var targetParentId, beforeId, kind;
			if ( d.isLeaf ) {
				kind = 'leaf';
				var col = this.nearestColumnEl( d.el );
				targetParentId = col ? col.getAttribute( 'data-fw-item-id' ) : null;
			} else if ( d.isColumn ) {
				kind = 'column';
				var sec = this.nearestSectionEl( d.el );
				targetParentId = sec ? sec.getAttribute( 'data-fw-item-id' ) : null;
			} else {
				kind = 'section';
				targetParentId = null; // sections are top-level
			}

			if ( ( d.isLeaf || d.isColumn ) && ! targetParentId ) {
				this.select( d.el, d.id ); // dropped nowhere valid — leave as-is
				return;
			}
			beforeId = this.nextItemId( d.el, kind );

			this.markEmptyColumns();
			this.ensureSectionAddColZones();
			this.ensureAddSectionZone();
			this.select( d.el, d.id );
			this.toShell( 'move-item', { id: d.id, targetParentId: targetParentId, beforeId: beforeId } );
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
			this.ensureSelectable( nu );
			this.markEmptyColumns();
			this.ensureSectionAddColZones();
			this.applyHiddenMark( payload.id );

			if ( this.hoverEl === old ) { this.hoverEl = null; }

			// A caller can ask to select a specific descendant after the swap (e.g.
			// the freshly-added column), so the user is taken straight to it instead
			// of the re-rendered container.
			if ( payload.selectId ) {
				var target = document.querySelector( '[data-fw-item-id="' + payload.selectId + '"]' );
				if ( target ) {
					this.select( target, payload.selectId );
					target.scrollIntoView( { behavior: 'smooth', block: 'center' } );
					return;
				}
			}

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
						parentId:  parentId,
						// Per-device "Hide on" map ({ 'hide-md': true, … }) — drives
						// the eye state + canvas dimming for the previewed device.
						responsiveHide: ( it.atts && it.atts.responsive_hide && typeof it.atts.responsive_hide === 'object' )
							? it.atts.responsive_hide : null
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
				trash: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
				addcol: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2.5" y="3.5" width="4.5" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11 5.5v5M8.5 8h5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
				tpl:   '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 6h11M6 6v7.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
				eye:   '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
				eyeOff: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5c1.2 0 2.3.4 3.2 1M14.5 8S12 12.5 8 12.5c-1.2 0-2.3-.4-3.2-1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 2.5l11 11" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>'
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
						'<button type="button" class="fw-le-tag__btn fw-le-act-addcol" title="Add column" style="display:none">' + SVG.addcol + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-savetpl" title="Save as Template" style="display:none">' + SVG.tpl + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-hide" title="Hide on the live site">' + SVG.eye + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-duplicate" title="Duplicate">' + SVG.copy + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-act-edit" title="Edit">' + SVG.edit + '</button>' +
						'<button type="button" class="fw-le-tag__btn fw-le-tag__btn--danger fw-le-act-delete" title="Delete">' + SVG.trash + '</button>' +
					'</div>' +
				'</div>' +
				'<div class="fw-le-resize" style="display:none" title="Drag to resize (12-column grid)"></div>' +
				'<div class="fw-le-resize-tip" style="display:none"></div>' +
				'<div id="fw-le-dropline" style="display:none"></div>';

			document.body.appendChild( root );

			this.els.root      = root;
			this.els.hoverBox  = root.querySelector( '.fw-le-box--hover' );
			this.els.activeBox = root.querySelector( '.fw-le-box--active' );
			this.els.activeLbl = root.querySelector( '.fw-le-tag__label' );
			this.els.addColBtn = root.querySelector( '.fw-le-act-addcol' );
			this.els.saveTplBtn = root.querySelector( '.fw-le-act-savetpl' );
			this.els.hideBtn   = root.querySelector( '.fw-le-act-hide' );
			this._svgEye       = SVG.eye;
			this._svgEyeOff    = SVG.eyeOff;
			this.els.resize    = root.querySelector( '.fw-le-resize' );
			this.els.resizeTip = root.querySelector( '.fw-le-resize-tip' );
			this.els.dropline  = root.querySelector( '#fw-le-dropline' );

			var self = this;
			this.els.resize.addEventListener( 'pointerdown', function ( e ) { self.startColResize( e ); } );
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
			on( '.fw-le-act-addcol', function () {
				if ( self.activeId ) { self.toShell( 'add-column', { id: self.activeId } ); }
			} );
			on( '.fw-le-act-savetpl', function () {
				if ( self.activeId ) { self.toShell( 'save-template-request', { id: self.activeId } ); }
			} );
			on( '.fw-le-act-hide', function () {
				if ( self.activeId ) { self.toggleHidden( self.activeId ); }
			} );
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
				if ( self.editing ) { return; }
				var hit = self.selectableFrom( e.target );
				self.setHover( hit ? hit.el : null );
			}, false );

			document.addEventListener( 'click', function ( e ) {
				if ( self.editing ) { return; } // let clicks place the caret while editing
				if ( e.target.closest && e.target.closest( '#fw-le-overlay' ) ) { return; }
				// Editor chrome injected into the canvas (add-section / add-column
				// bars) handles its own clicks — don't hijack them for selection.
				if ( e.target.closest && e.target.closest( '.fw-le-addcol-zone, .fw-le-add-section-zone' ) ) { return; }
				var hit = self.selectableFrom( e.target );
				if ( hit ) {
					e.preventDefault();
					e.stopPropagation();
					self.select( hit.el, hit.id );
				}
			}, { capture: true, passive: false } );

			// Double-click a text block to edit it inline (cursor at the click point).
			document.addEventListener( 'dblclick', function ( e ) { self.onDblClick( e ); }, false );

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

			// Relay undo/redo keys to the shell — but not while inline-editing text,
			// where Ctrl+Z should do the browser's native text undo.
			document.addEventListener( 'keydown', function ( e ) {
				if ( self.editing ) { return; }
				if ( ! ( e.ctrlKey || e.metaKey ) ) { return; }
				var k = ( e.key || '' ).toLowerCase();
				if ( k === 'z' && ! e.shiftKey ) { e.preventDefault(); self.toShell( 'undo', {} ); }
				else if ( k === 'y' || ( k === 'z' && e.shiftKey ) ) { e.preventDefault(); self.toShell( 'redo', {} ); }
			}, false );
			// Drag-to-add uses the shell's pointer-capture relay (add-dragover /
			// add-drop messages → pointerAddOver / pointerAddDrop), not native DnD,
			// since native HTML5 DnD can't reliably cross the same-origin iframe.
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

			var meta = this.index[ id ] || {};
			// "+ Column" is only meaningful on a section (adds a column to it).
			var isSection = /section$/.test( meta.type || '' );
			if ( this.els.addColBtn ) { this.els.addColBtn.style.display = isSection ? '' : 'none'; }
			// "Save as Template" applies to sections + columns (the granularities that
			// have a template component on the server).
			var isColumn = meta.type === 'column';
			if ( this.els.saveTplBtn ) { this.els.saveTplBtn.style.display = ( isSection || isColumn ) ? '' : 'none'; }
			this.updateTagHiddenState();
			this.toShell( 'select', {
				id:    id,
				type:  meta.type,
				label: meta.label
			} );
		},

		/** Sync the hide button's icon + tooltip with the active item's visibility
		 *  on the PREVIEWED device (the eye reflects the current breakpoint). */
		updateTagHiddenState: function () {
			var btn = this.els.hideBtn;
			if ( ! btn ) { return; }
			var meta = this.activeId ? this.index[ this.activeId ] : null;
			var hidden = hiddenOnDevice( meta, this.device );
			var dev = DEVICE_LABEL[ this.device ] || 'this device';
			btn.innerHTML = hidden ? this._svgEyeOff : this._svgEye;
			btn.setAttribute( 'title', hidden
				? ( 'Hidden on ' + dev + ' — click to show' )
				: ( 'Hide on ' + dev ) );
			btn.classList.toggle( 'is-on', hidden );
		},

		/** Toggle the active item's visibility on the PREVIEWED device. Optimistic:
		 *  flip the local responsive_hide map + dim + button, then tell the shell to
		 *  persist it into the model's `responsive_hide` option. */
		toggleHidden: function ( id ) {
			var meta = this.index[ id ];
			if ( ! meta ) { return; }
			var cls = DEVICE_HIDE[ this.device ] || DEVICE_HIDE.desktop;
			// Empty default arrives as an array ([]); writing a string key to it is
			// lost on serialize — so only reuse a real (non-array) object map.
			var rh = ( meta.responsiveHide && ! Array.isArray( meta.responsiveHide )
				&& typeof meta.responsiveHide === 'object' ) ? meta.responsiveHide : {};
			var want = ! rh[ cls ];
			if ( want ) { rh[ cls ] = true; } else { delete rh[ cls ]; }
			meta.responsiveHide = rh;
			this.applyHiddenMark( id );
			if ( id === this.activeId ) { this.updateTagHiddenState(); }
			this.toShell( 'toggle-hidden', { id: id, device: this.device, hidden: want } );
		},

		/** Dim a single id if it's hidden on the previewed device. */
		applyHiddenMark: function ( id ) {
			var el = document.querySelector( '[data-fw-item-id="' + id + '"]' );
			var meta = this.index[ id ];
			if ( el && meta ) { el.classList.toggle( 'fw-le-item-hidden', hiddenOnDevice( meta, this.device ) ); }
		},

		/** Re-apply hidden dimming across the canvas for the previewed device. */
		refreshHiddenMarks: function () {
			var els = document.querySelectorAll( '[data-fw-item-id]' );
			for ( var i = 0; i < els.length; i++ ) {
				var meta = this.index[ els[ i ].getAttribute( 'data-fw-item-id' ) ];
				els[ i ].classList.toggle( 'fw-le-item-hidden', hiddenOnDevice( meta, this.device ) );
			}
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
			this.updateResizeHandle();
		},

		/** Show + position the column resize grip on the right edge of the selected
		 *  column (hidden for any non-column selection or while dragging it). */
		updateResizeHandle: function () {
			var h = this.els.resize;
			if ( ! h ) { return; }
			var meta = this.activeId ? this.index[ this.activeId ] : null;
			if ( ! this.activeEl || ! meta || meta.type !== 'column' || this.colResize ) {
				h.style.display = 'none';
				return;
			}
			var rc = this.activeEl.getBoundingClientRect();
			h.style.display = 'block';
			h.style.top  = ( rc.top + rc.height / 2 - 18 ) + 'px';
			h.style.left = ( rc.right - 6 ) + 'px';
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
