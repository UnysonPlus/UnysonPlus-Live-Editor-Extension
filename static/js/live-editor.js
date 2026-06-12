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

	// Twelfths → the page-builder width fraction id (mirrors builder grid.columns).
	var GRID_ID = {
		1: '1_12', 2: '1_6', 3: '1_4', 4: '1_3', 5: '5_12', 6: '1_2',
		7: '7_12', 8: '2_3', 9: '3_4', 10: '5_6', 11: '11_12', 12: '1_1'
	};

	// Width fraction id → twelfths (the inverse, plus the odd 1/5 and auto col).
	var TW_OF = {
		'1_12': 1, '1_6': 2, '1_5': 2, '1_4': 3, '1_3': 4, '5_12': 5, '1_2': 6,
		'7_12': 7, '2_3': 8, '3_4': 9, '5_6': 10, '11_12': 11, '1_1': 12, 'col': 12
	};

	function twOf( width ) { return TW_OF[ width ] || 12; }

	/** Reduced fraction label for a fraction id ("1_2" → "1/2"). */
	function fracOf( id ) { return String( id || '' ).replace( '_', '/' ); }

	/** Even-split N columns across the 12-grid (remainder spread to the first
	 *  columns), returning an array of width fraction ids. Always sums to 12. */
	function evenWidths( count ) {
		count = Math.max( 1, Math.min( 12, count ) );
		var base = Math.floor( 12 / count ), rem = 12 % count, out = [];
		for ( var i = 0; i < count; i++ ) { out.push( GRID_ID[ base + ( i < rem ? 1 : 0 ) ] ); }
		return out;
	}

	/** The array that directly holds a section's column items — the section's
	 *  _items when those are columns, else a contained row's _items (some saved
	 *  trees wrap columns in an explicit row). */
	function columnArrayOf( node ) {
		if ( ! node._items ) { node._items = []; }
		var hasCol = node._items.some( function ( it ) { return it && it.type === 'column'; } );
		if ( hasCol || ! node._items.length ) { return node._items; }
		var row = node._items.filter( function ( it ) { return it && it.type === 'row'; } )[ 0 ];
		if ( row ) { if ( ! row._items ) { row._items = []; } return row._items; }
		return node._items;
	}

	// Column-structure presets for the picker. `parts` are flex weights for the
	// thumbnail; `cols` are the width fraction ids the section is built with.
	var LAYOUTS = [
		{ cols: [ '1_1' ],                               parts: [ 12 ] },
		{ cols: [ '1_2', '1_2' ],                        parts: [ 6, 6 ] },
		{ cols: [ '1_3', '1_3', '1_3' ],                 parts: [ 4, 4, 4 ] },
		{ cols: [ '1_4', '1_4', '1_4', '1_4' ],          parts: [ 3, 3, 3, 3 ] },
		{ cols: [ '1_3', '2_3' ],                        parts: [ 4, 8 ] },
		{ cols: [ '2_3', '1_3' ],                        parts: [ 8, 4 ] },
		{ cols: [ '1_4', '3_4' ],                        parts: [ 3, 9 ] },
		{ cols: [ '3_4', '1_4' ],                        parts: [ 9, 3 ] },
		{ cols: [ '1_4', '1_2', '1_4' ],                 parts: [ 3, 6, 3 ] },
		{ cols: [ '1_6', '1_6', '1_6', '1_6', '1_6', '1_6' ], parts: [ 2, 2, 2, 2, 2, 2 ] }
	];

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
			this.buildPanel();

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
				if ( type !== 'add-dragover' ) { this.log( 'send → frame', type ); } // high-frequency: skip
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
				case 'move-item':
					this.moveItem( data.payload );
					break;
				case 'add-element':
					this.addElement( data.payload );
					break;
				case 'update-text':
					this.updateText( data.payload );
					break;
				case 'resize-column':
					this.resizeColumn( data.payload );
					break;
				case 'add-column':
				case 'open-column-picker':
					this.openColumnPicker( data.payload && data.payload.id );
					break;
				case 'open-structure-picker':
					this.openStructurePicker();
					break;
				default:
					break;
			}
		},

		/* ---- add-element panel (Phase C) ------------------------------- */

		buildPanel: function () {
			var self = this;
			var elements = cfg.elements || [];

			// "Add" toggle in the toolbar.
			this.$.addBtn = $(
				'<button type="button" id="fw-le-add" class="fw-le-btn fw-le-btn--ghost">' +
					'<span class="dashicons dashicons-plus-alt2"></span> ' + ( ( cfg.l10n && cfg.l10n.add ) || 'Add' ) +
				'</button>'
			).prependTo( '#fw-le-toolbar .fw-le-toolbar__group--left' );
			this.$.addBtn.on( 'click', function () { $( 'body' ).toggleClass( 'fw-le-panel-open' ); } );

			// "Add Section" — opens the structure picker (choose a column layout +
			// section type), then inserts that section at the end of the page.
			this.$.sectionBtn = $(
				'<button type="button" id="fw-le-add-section" class="fw-le-btn fw-le-btn--ghost">' +
					'<span class="dashicons dashicons-screenoptions"></span> ' + ( ( cfg.l10n && cfg.l10n.addSection ) || 'Section' ) +
				'</button>'
			).insertAfter( this.$.addBtn );
			this.$.sectionBtn.on( 'click', function () { self.openStructurePicker(); } );
			this.buildStructurePicker();

			var $panel = $(
				'<aside id="fw-le-panel">' +
					'<div class="fw-le-panel__head"><strong>' + ( ( cfg.l10n && cfg.l10n.addElement ) || 'Add Element' ) + '</strong>' +
						'<button type="button" class="fw-le-panel__close" aria-label="Close">&times;</button></div>' +
					'<div class="fw-le-panel__search"><input type="search" placeholder="' + ( ( cfg.l10n && cfg.l10n.search ) || 'Search…' ) + '"></div>' +
					'<div class="fw-le-panel__body"></div>' +
				'</aside>'
			);
			var $body = $panel.find( '.fw-le-panel__body' );

			// Group by tab.
			var groups = {}, order = [];
			elements.forEach( function ( el ) {
				var tab = el.tab || 'Elements';
				if ( ! groups[ tab ] ) { groups[ tab ] = []; order.push( tab ); }
				groups[ tab ].push( el );
			} );

			order.forEach( function ( tab ) {
				var $grp = $( '<div class="fw-le-panel__group"><div class="fw-le-panel__grouptitle"></div><div class="fw-le-panel__tiles"></div></div>' );
				$grp.find( '.fw-le-panel__grouptitle' ).text( tab );
				var $tiles = $grp.find( '.fw-le-panel__tiles' );
				groups[ tab ].forEach( function ( el ) {
					var $tile = $( '<div class="fw-le-tile"><span class="fw-le-tile__icon"></span><span class="fw-le-tile__title"></span></div>' );
					$tile.attr( 'data-tag', el.tag ).attr( 'data-search', ( el.title + ' ' + el.tag ).toLowerCase() );
					$tile.find( '.fw-le-tile__title' ).text( el.title );
					if ( el.icon ) {
						if ( el.icon.charAt( 0 ) === '<' ) { $tile.find( '.fw-le-tile__icon' ).html( el.icon ); }
						else { $tile.find( '.fw-le-tile__icon' ).html( '<img src="' + el.icon + '" alt="">' ); }
					}
					// Pointer-capture drag (native DnD can't cross the iframe boundary).
					( function ( info ) {
						$tile[ 0 ].addEventListener( 'pointerdown', function ( e ) {
							if ( e.button !== 0 ) { return; }
							self.startPanelDrag( info, e );
						} );
					} )( { tag: el.tag, title: el.title } );
					$tiles.append( $tile );
				} );
				$body.append( $grp );
			} );

			$panel.find( '.fw-le-panel__close' ).on( 'click', function () { $( 'body' ).removeClass( 'fw-le-panel-open' ); } );
			$panel.find( '.fw-le-panel__search input' ).on( 'input', function () {
				var q = this.value.toLowerCase();
				$panel.find( '.fw-le-tile' ).each( function () {
					this.style.display = ( this.getAttribute( 'data-search' ).indexOf( q ) !== -1 ) ? '' : 'none';
				} );
			} );

			$( '#fw-live-editor-app' ).append( $panel );
		},

		addElement: function ( payload ) {
			payload = payload || {};
			if ( ! payload.tag || ! payload.targetParentId ) { return; }

			var self = this;
			this.ajax( cfg.actions.newItem, { tag: payload.tag }, function ( resp ) {
				if ( ! ( resp && resp.success && resp.data && resp.data.item ) ) {
					window.console && console.error( '[fw-le-shell] new element failed', resp );
					return;
				}
				var item = resp.data.item;
				var id   = ( item.atts && item.atts.unique_id ) || item.unique_id;

				var targetParent = self.index[ payload.targetParentId ];
				if ( ! targetParent ) { return; }
				var node = targetParent.node;
				if ( ! node._items ) { node._items = []; }

				var insertAt = node._items.length;
				if ( payload.beforeId && self.index[ payload.beforeId ] && self.index[ payload.beforeId ].siblings === node._items ) {
					var bi = node._items.indexOf( self.index[ payload.beforeId ].node );
					if ( bi >= 0 ) { insertAt = bi; }
				}
				node._items.splice( insertAt, 0, item );

				self.rebuildIndex();
				self.markDirty();
				self.syncFrameModel();
				self.toFrame( 'insert-element', {
					html:           resp.data.html,
					targetParentId: payload.targetParentId,
					beforeId:       payload.beforeId,
					id:             id
				} );

				// Open the editor right away so a just-added element can always be
				// configured (many render empty until set up). Text blocks are
				// skipped — they arrive with visible content and are double-click
				// editable.
				if ( item.shortcode !== 'text_block' ) {
					window.setTimeout( function () { self.openEditor( id ); }, 80 );
				}
			} );
		},

		/* ---- structure picker (choose section layout + type) ----------- */

		buildStructurePicker: function () {
			var self = this;
			var l10n = cfg.l10n || {};
			var types = cfg.sectionTypes || [ { id: 'section', title: 'Standard' } ];

			var $pick = this.$.picker = $(
				'<div class="fw-le-picker-backdrop" style="display:none">' +
					'<div class="fw-le-picker" role="dialog" aria-modal="true">' +
						'<div class="fw-le-picker__head">' +
							'<strong>' + ( l10n.structure || 'Choose a structure' ) + '</strong>' +
							'<button type="button" class="fw-le-picker__close" aria-label="Close">&times;</button>' +
						'</div>' +
						'<div class="fw-le-picker__types"></div>' +
						'<div class="fw-le-picker__grid"></div>' +
					'</div>' +
				'</div>'
			).appendTo( 'body' );

			// Section-type pills (only when more than one type exists).
			var $types = $pick.find( '.fw-le-picker__types' );
			if ( types.length > 1 ) {
				$types.append( '<span class="fw-le-picker__typelbl">' + ( l10n.sectionType || 'Section type' ) + '</span>' );
				types.forEach( function ( t, i ) {
					var $p = $( '<button type="button" class="fw-le-picker__type"></button>' )
						.attr( 'data-type', t.id ).text( t.title );
					if ( i === 0 ) { $p.addClass( 'is-active' ); }
					$types.append( $p );
				} );
				this.pickerType = types[ 0 ].id;
				$types.on( 'click', '.fw-le-picker__type', function () {
					$types.find( '.fw-le-picker__type' ).removeClass( 'is-active' );
					$( this ).addClass( 'is-active' );
					self.pickerType = $( this ).attr( 'data-type' );
				} );
			} else {
				this.pickerType = types[ 0 ] ? types[ 0 ].id : 'section';
				$types.hide();
			}

			// Layout tiles (CSS-drawn column splits).
			var $grid = $pick.find( '.fw-le-picker__grid' );
			LAYOUTS.forEach( function ( lay, idx ) {
				var bars = lay.parts.map( function ( p ) {
					return '<span style="flex:' + p + '"></span>';
				} ).join( '' );
				var $tile = $( '<button type="button" class="fw-le-picker__tile"><span class="fw-le-picker__cols">' + bars + '</span></button>' );
				$tile.attr( 'data-idx', idx ).attr( 'title', lay.parts.length + ' column' + ( lay.parts.length > 1 ? 's' : '' ) );
				$grid.append( $tile );
			} );

			$grid.on( 'click', '.fw-le-picker__tile', function () {
				var lay = LAYOUTS[ parseInt( $( this ).attr( 'data-idx' ), 10 ) ];
				if ( lay ) { self.addSection( lay.cols, self.pickerType ); }
				self.closeStructurePicker();
			} );

			$pick.find( '.fw-le-picker__close' ).on( 'click', function () { self.closeStructurePicker(); } );
			$pick.on( 'click', function ( e ) { if ( e.target === $pick[ 0 ] ) { self.closeStructurePicker(); } } );
		},

		openStructurePicker: function () {
			if ( ! this.$.picker ) { this.buildStructurePicker(); }
			this.$.picker.css( 'display', 'flex' );
		},

		closeStructurePicker: function () {
			if ( this.$.picker ) { this.$.picker.hide(); }
		},

		/** Insert a fresh section with the chosen column layout + type at the page
		 *  root. The server builds the section+columns and renders the HTML (with
		 *  structure-correction on); we add the item to the model and drop the HTML
		 *  after the last section (or, on an empty page, the frame appends it). */
		addSection: function ( cols, type ) {
			var self = this;
			var data = {
				cols:         JSON.stringify( cols || [ '1_1' ] ),
				section_type: type || 'section'
			};
			this.ajax( cfg.actions.newSection, data, function ( resp ) {
				if ( ! ( resp && resp.success && resp.data && resp.data.item ) ) {
					window.console && console.error( '[fw-le-shell] new section failed', resp );
					return;
				}
				var item = resp.data.item;
				var id   = ( item.atts && item.atts.unique_id ) || item.unique_id;

				var prevLast = self.model.length ? self.model[ self.model.length - 1 ] : null;
				var afterId  = prevLast ? ( ( prevLast.atts && prevLast.atts.unique_id ) || prevLast.unique_id ) : null;

				self.model.push( item );
				self.rebuildIndex();
				self.markDirty();
				self.syncFrameModel();
				self.toFrame( 'insert-section', { html: resp.data.html, id: id, afterId: afterId } );

				$( 'body' ).addClass( 'fw-le-panel-open' );
			} );
		},

		/* ---- column picker (add a column of a chosen width) ------------ */

		/** Open the column-width modal for a section. Matches the classic backend
		 *  builder: every grid width (1/1 … 1/12) is offered, and picking one adds a
		 *  SINGLE column of exactly that width. Existing columns are untouched; the
		 *  grid wraps a row that overflows 12 (e.g. a 1/4 added to a full 1/1 row
		 *  drops to a new row on the left). */
		openColumnPicker: function ( sectionId ) {
			var entry = sectionId && this.index[ sectionId ];
			if ( ! entry || ! isContainer( entry.node ) ) { return; }

			var self = this;
			var l10n = cfg.l10n || {};

			if ( this.$.colPicker ) { this.$.colPicker.remove(); }
			var $pick = this.$.colPicker = $(
				'<div class="fw-le-picker-backdrop" style="display:none">' +
					'<div class="fw-le-picker fw-le-picker--col" role="dialog" aria-modal="true">' +
						'<div class="fw-le-picker__head">' +
							'<strong>' + ( l10n.addColumn || 'Add Column' ) + '</strong>' +
							'<button type="button" class="fw-le-picker__close" aria-label="Close">&times;</button>' +
						'</div>' +
						'<div class="fw-le-picker__grid fw-le-picker__grid--col"></div>' +
					'</div>' +
				'</div>'
			).appendTo( 'body' );

			var $grid = $pick.find( '.fw-le-picker__grid' );
			for ( var tw = 12; tw >= 1; tw-- ) {
				var id = GRID_ID[ tw ];
				var pct = Math.round( ( tw / 12 ) * 100 );
				var $tile = $(
					'<button type="button" class="fw-le-picker__tile fw-le-coltile">' +
						'<span class="fw-le-picker__cols"><span style="flex:' + tw + '"></span><span class="fw-le-coltile__rest" style="flex:' + ( 12 - tw ) + '"></span></span>' +
						'<span class="fw-le-coltile__lbl">' + fracOf( id ) + '</span>' +
					'</button>'
				);
				$tile.attr( 'data-width', id ).attr( 'title', fracOf( id ) + '  (' + pct + '%)' );
				$grid.append( $tile );
			}

			$grid.on( 'click', '.fw-le-coltile', function () {
				self.addColumn( sectionId, $( this ).attr( 'data-width' ) );
				$pick.remove();
				self.$.colPicker = null;
			} );
			$pick.find( '.fw-le-picker__close' ).on( 'click', function () { $pick.remove(); self.$.colPicker = null; } );
			$pick.on( 'click', function ( e ) { if ( e.target === $pick[ 0 ] ) { $pick.remove(); self.$.colPicker = null; } } );

			$pick.css( 'display', 'flex' );
		},

		/** Append a SINGLE column of `width` to a section — exactly like the backend
		 *  builder. Existing columns keep their widths; the page-builder's row
		 *  correction wraps the row when the cumulative width exceeds 12. */
		addColumn: function ( sectionId, width ) {
			var entry = sectionId && this.index[ sectionId ];
			if ( ! entry || ! isContainer( entry.node ) ) { return; }
			var section = entry.node;
			var self = this;
			width = width || '1_1';

			this.ajax( cfg.actions.newColumn, {}, function ( resp ) {
				if ( ! ( resp && resp.success && resp.data && resp.data.item ) ) {
					window.console && console.error( '[fw-le-shell] new column failed', resp );
					return;
				}
				var col = resp.data.item;
				col.width = width;
				var newColId = ( col.atts && col.atts.unique_id ) || col.unique_id;
				columnArrayOf( section ).push( col );

				self.rebuildIndex();
				self.markDirty();
				self.syncFrameModel();

				self.ajax( cfg.actions.renderItem, { item: JSON.stringify( section ) }, function ( r ) {
					if ( r && r.success && r.data && typeof r.data.html === 'string' ) {
						self.toFrame( 'replace', {
							id:       sectionId,
							html:     r.data.html,
							selectId: newColId   // select + scroll to the new column
						} );
					}
				} );
			} );
		},

		/* ---- pointer-capture drag from the panel ----------------------- */

		startPanelDrag: function ( info, e ) {
			e.preventDefault();
			var self = this;
			var captureEl = e.target.closest ? ( e.target.closest( '.fw-le-tile' ) || e.target ) : e.target;

			this.panelDrag = {
				tag: info.tag, title: info.title, pointerId: e.pointerId,
				el: captureEl, startX: e.clientX, startY: e.clientY,
				started: false, overFrame: false
			};
			try { captureEl.setPointerCapture( e.pointerId ); } catch ( err ) {}

			this.panelDrag.move = function ( ev ) { self.onPanelMove( ev ); };
			this.panelDrag.up   = function ( ev ) { self.onPanelUp( ev ); };
			captureEl.addEventListener( 'pointermove', this.panelDrag.move, true );
			captureEl.addEventListener( 'pointerup', this.panelDrag.up, true );
			captureEl.addEventListener( 'pointercancel', this.panelDrag.up, true );
			this.log( 'panel drag start', info.tag );
		},

		onPanelMove: function ( e ) {
			var pd = this.panelDrag;
			if ( ! pd ) { return; }
			if ( ! pd.started ) {
				if ( Math.abs( e.clientX - pd.startX ) + Math.abs( e.clientY - pd.startY ) < 4 ) { return; }
				pd.started = true;
				this.$.ghost = $( '<div class="fw-le-drag-ghost" />' ).text( pd.title ).appendTo( 'body' );
				$( 'body' ).addClass( 'fw-le-adding' );
				this.log( 'panel drag began' );
			}
			this.positionGhost( e.clientX, e.clientY );

			var r = this.$.frame[ 0 ].getBoundingClientRect();
			var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
			if ( inside ) {
				pd.overFrame = true;
				this.toFrame( 'add-dragover', { x: e.clientX - r.left, y: e.clientY - r.top, tag: pd.tag } );
			} else if ( pd.overFrame ) {
				pd.overFrame = false;
				this.toFrame( 'add-dragend', {} );
			}
		},

		onPanelUp: function ( e ) {
			var pd = this.panelDrag;
			if ( ! pd ) { return; }
			var el = pd.el;
			el.removeEventListener( 'pointermove', pd.move, true );
			el.removeEventListener( 'pointerup', pd.up, true );
			el.removeEventListener( 'pointercancel', pd.up, true );
			try { el.releasePointerCapture( pd.pointerId ); } catch ( err ) {}

			if ( this.$.ghost ) { this.$.ghost.remove(); this.$.ghost = null; }
			$( 'body' ).removeClass( 'fw-le-adding' );
			this.panelDrag = null;

			var r = this.$.frame[ 0 ].getBoundingClientRect();
			var inside = pd.started && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
			this.log( 'panel drag end', { inside: inside, overFrame: pd.overFrame } );
			if ( inside ) {
				this.toFrame( 'add-drop', { x: e.clientX - r.left, y: e.clientY - r.top, tag: pd.tag } );
			} else {
				this.toFrame( 'add-dragend', {} );
			}
		},

		positionGhost: function ( x, y ) {
			if ( this.$.ghost ) { this.$.ghost.css( { left: ( x + 14 ) + 'px', top: ( y + 14 ) + 'px' } ); }
		},

		/** Inline text edit committed (double-click). Store the HTML in the model;
		 *  the canvas already shows it, so no re-render is needed. */
		updateText: function ( payload ) {
			payload = payload || {};
			var node = this.nodeOf( payload.id );
			if ( ! node ) { return; }
			if ( ! node.atts ) { node.atts = {}; }
			if ( node.atts.text === payload.text ) { return; } // no change
			node.atts.text = payload.text;
			this.markDirty();
		},

		/** Column resized on the canvas (drag the 12-col grid handle). The frame
		 *  already updated the DOM classes; mirror the new width(s) into the model
		 *  (`width` is a top-level key on a column item) so the change persists. */
		resizeColumn: function ( payload ) {
			payload = payload || {};
			var node = this.nodeOf( payload.id );
			if ( ! node || ! payload.width ) { return; }
			node.width = payload.width;

			if ( payload.siblingId && payload.siblingWidth ) {
				var sib = this.nodeOf( payload.siblingId );
				if ( sib ) { sib.width = payload.siblingWidth; }
			}
			this.markDirty();
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

		/** Move an item within OR across containers (Phase B/C). The frame already
		 *  moved the DOM node; here we mirror the move in the model. payload:
		 *  { id, targetParentId (the new parent item id, or null = page root),
		 *    beforeId (sibling it now sits before, or null = end) }. */
		moveItem: function ( payload ) {
			payload = payload || {};
			var entry = payload.id && this.index[ payload.id ];
			if ( ! entry ) { return; }

			var node        = entry.node;
			var oldSiblings = entry.siblings;
			var from        = oldSiblings.indexOf( node );
			if ( from < 0 ) { return; }

			// Resolve the destination array (the new parent's _items, or the root).
			var targetParent = payload.targetParentId ? this.index[ payload.targetParentId ] : null;
			var targetSiblings;
			if ( payload.targetParentId ) {
				if ( ! targetParent ) { this.log( 'move: unknown target parent', payload.targetParentId ); return; }
				if ( ! targetParent.node._items ) { targetParent.node._items = []; }
				targetSiblings = targetParent.node._items;
			} else {
				targetSiblings = this.model;
			}

			var sameContainer = ( targetSiblings === oldSiblings );

			var insertAt;
			if ( payload.beforeId && this.index[ payload.beforeId ] ) {
				insertAt = targetSiblings.indexOf( this.index[ payload.beforeId ].node );
				if ( insertAt < 0 ) { insertAt = targetSiblings.length; }
			} else {
				insertAt = targetSiblings.length;
			}

			oldSiblings.splice( from, 1 );
			if ( sameContainer && insertAt > from ) { insertAt--; }
			if ( sameContainer && insertAt === from ) {
				oldSiblings.splice( from, 0, node ); // back where it was → no change
				return;
			}

			targetSiblings.splice( insertAt, 0, node );

			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
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
