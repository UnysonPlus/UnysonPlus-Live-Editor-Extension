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
	var HISTORY_MAX = 60;

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

	// Preview device → the responsive_hide choice key ("Hide on") that hides at
	// that breakpoint. The eye toggles the key for whichever device is previewed.
	var DEVICE_HIDE = { desktop: 'hide-md', tablet: 'hide-sm', mobile: 'hide-xs' };

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

	/** The template granularity ("full" | "section" | "column") an element in the
	 *  injected templates HTML belongs to — read from its wrapping `[data-type]`. */
	function tplTypeOf( $el ) {
		return $el.closest( '.fw-builder-templates-type' ).attr( 'data-type' ) || '';
	}

	/** Index of the top-level item whose unique_id is `id` (or -1). */
	function indexOfId( arr, id ) {
		for ( var i = 0; i < arr.length; i++ ) {
			var it = arr[ i ];
			var iid = ( it && it.atts && it.atts.unique_id ) || ( it && it.unique_id );
			if ( iid === id ) { return i; }
		}
		return -1;
	}

	/** Nav label + type badge for a top-level (section) item. The label is the
	 *  section's CSS ID (its name/anchor) if set, else a positional "Section N".
	 *  The badge is shown only for non-standard section types. */
	function sectionMeta( item, index ) {
		var type = item.type;
		var badge = type === 'bleed_section' ? 'Bleed'
			: type === 'masonry_section' ? 'Masonry'
			: /section$/.test( type || '' ) ? '' // Standard → no badge
			: titleize( type );
		var name = ( item.atts && item.atts.css_id ) ? String( item.atts.css_id ).trim() : '';
		return { label: name || ( 'Section ' + ( index + 1 ) ), badge: badge, named: !! name };
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
		undoStack: [],
		redoStack: [],
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
			this.$.undo   = $( '#fw-le-undo' );
			this.$.redo   = $( '#fw-le-redo' );
			this.$.preview = $( '#fw-le-preview' );

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
			this.$.undo.on( 'click', this.undo.bind( this ) );
			this.$.redo.on( 'click', this.redo.bind( this ) );
			this.$.preview.on( 'click', this.onPreview.bind( this ) );

			var self = this;
			$( '#fw-le-devices' ).on( 'click', '.fw-le-device', function () {
				self.setDevice( this.getAttribute( 'data-device' ) );
			} );
			this.buildIndex( this.model, null );
			this.buildPanel();
			this.refreshUndoRedo();

			window.addEventListener( 'message', this.onMessage.bind( this ), false );
			$( document ).on( 'keydown', this.onKeydown.bind( this ) );

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
				case 'edit-image':
					this.openImagePicker( data.payload && data.payload.id );
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
				case 'save-template-request':
					this.saveItemAsTemplate( data.payload && data.payload.id );
					break;
				case 'toggle-hidden':
					this.setItemHidden( data.payload );
					break;
				case 'undo':
					this.undo();
					break;
				case 'redo':
					this.redo();
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
			// Section structure picker stays available — reached from the in-canvas
			// "+ Add Section" zone (and the blank-page empty state), so no redundant
			// toolbar button competing with the "Sections" navigator below.
			this.buildStructurePicker();

			// "Sections" — a navigator panel listing every section: click to jump,
			// drag to reorder, double-click to rename (invaluable on long pages).
			this.$.navBtn = $(
				'<button type="button" id="fw-le-nav-btn" class="fw-le-btn fw-le-btn--ghost">' +
					'<span class="dashicons dashicons-menu-alt"></span> ' + ( ( cfg.l10n && cfg.l10n.navigator ) || 'Sections' ) +
				'</button>'
			).insertAfter( this.$.addBtn );
			this.$.navBtn.on( 'click', function () {
				var open = ! $( 'body' ).hasClass( 'fw-le-nav-open' );
				$( 'body' ).removeClass( 'fw-le-panel-open fw-le-tpl-open' ).toggleClass( 'fw-le-nav-open', open );
				if ( open ) { self.refreshNavigator(); }
			} );
			this.buildNavigator();

			// "Templates" — save the page / a section / a column as a reusable
			// builder template, and drop saved templates back onto the canvas.
			// Drives the framework's standard fw_builder_templates_* handlers.
			if ( cfg.templates && cfg.templates.enabled ) {
				this.$.tplBtn = $(
					'<button type="button" id="fw-le-tpl-btn" class="fw-le-btn fw-le-btn--ghost">' +
						'<span class="dashicons dashicons-screenoptions"></span> ' + ( ( cfg.l10n && cfg.l10n.templates ) || 'Templates' ) +
					'</button>'
				).insertAfter( this.$.navBtn );
				this.$.tplBtn.on( 'click', function () {
					var open = ! $( 'body' ).hasClass( 'fw-le-tpl-open' );
					$( 'body' ).removeClass( 'fw-le-panel-open fw-le-nav-open' ).toggleClass( 'fw-le-tpl-open', open );
					if ( open ) { self.refreshTemplates(); }
				} );
				this.buildTemplatesPanel();
			}

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
				self.recordHistory();
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

				self.recordHistory();
				self.model.push( item );
				self.rebuildIndex();
				self.markDirty();
				self.syncFrameModel();
				self.toFrame( 'insert-section', { html: resp.data.html, id: id, afterId: afterId } );
				self.refreshNavigator();

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
				self.recordHistory();
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

		/* ---- section navigator ----------------------------------------- */

		buildNavigator: function () {
			var self = this;
			var l10n = cfg.l10n || {};
			var $nav = this.$.nav = $(
				'<aside id="fw-le-nav">' +
					'<div class="fw-le-panel__head"><strong>' + ( l10n.navigator || 'Sections' ) + '</strong>' +
						'<button type="button" class="fw-le-panel__close" aria-label="Close">&times;</button></div>' +
					'<div class="fw-le-nav__body"></div>' +
				'</aside>'
			).appendTo( '#fw-live-editor-app' );

			$nav.find( '.fw-le-panel__close' ).on( 'click', function () { $( 'body' ).removeClass( 'fw-le-nav-open' ); } );

			var $body = $nav.find( '.fw-le-nav__body' );

			// Click a row → jump to that section in the canvas.
			$body.on( 'click', '.fw-le-nav__item', function ( e ) {
				if ( e.target.closest( '.fw-le-nav__grip' ) || e.target.closest( '.fw-le-nav__rename' ) ) { return; }
				self.toFrame( 'select-item', { id: this.getAttribute( 'data-id' ) } );
			} );

			// Double-click the label → rename the section (writes its CSS ID, which
			// the section view renders as a normalized HTML id/anchor).
			$body.on( 'dblclick', '.fw-le-nav__label', function ( e ) {
				e.stopPropagation();
				self.renameSection( this.closest( '.fw-le-nav__item' ), this );
			} );

			// Pointer-based reorder from the grip (HTML5 DnD proved unreliable here).
			$body.on( 'pointerdown', '.fw-le-nav__grip', function ( e ) {
				e.preventDefault();
				self.startNavDrag( this.closest( '.fw-le-nav__item' ), this, e );
			} );
		},

		startNavDrag: function ( row, grip, e ) {
			if ( ! row ) { return; }
			var self = this;
			// Bind to window (not the grip): the row — and the grip inside it — get
			// moved in the DOM during the drag, which drops pointer-capture and would
			// otherwise lose the pointerup. The cursor stays in the panel, so window
			// catches every move/up reliably.
			var d = this._navDrag = {
				row: row, id: row.getAttribute( 'data-id' ),
				startY: e.clientY, started: false, clone: null, grabDY: 0
			};
			d.move = function ( ev ) { self.onNavDragMove( ev ); };
			d.up   = function ( ev ) { self.onNavDragUp( ev ); };
			window.addEventListener( 'pointermove', d.move, true );
			window.addEventListener( 'pointerup', d.up, true );
			window.addEventListener( 'pointercancel', d.up, true );
		},

		onNavDragMove: function ( e ) {
			var d = this._navDrag;
			if ( ! d ) { return; }

			// Begin only after a small threshold (so a click on the grip still works).
			if ( ! d.started ) {
				if ( Math.abs( e.clientY - d.startY ) < 4 ) { return; }
				d.started = true;

				var rect = d.row.getBoundingClientRect();
				d.grabDY = e.clientY - rect.top;

				// A floating clone follows the cursor (the "lifted" block); the
				// original row stays in the list as a faded placeholder gap.
				var clone = d.clone = d.row.cloneNode( true );
				clone.className = d.row.className + ' fw-le-nav__clone';
				clone.style.cssText = 'position:fixed; left:' + rect.left + 'px; width:' + rect.width +
					'px; margin:0; pointer-events:none; z-index:100002;';
				document.body.appendChild( clone );
				d.row.classList.add( 'fw-le-nav__placeholder' );
			}

			d.clone.style.top = ( e.clientY - d.grabDY ) + 'px';
			this.navReorder( e.clientY );
		},

		/** Slide the placeholder gap to where the cursor is, FLIP-animating the rows
		 *  that shift so they smoothly move out of the way. */
		navReorder: function ( clientY ) {
			var d = this._navDrag;
			var $body = this.$.nav.find( '.fw-le-nav__body' );
			var items = $body.children( '.fw-le-nav__item' ).toArray();

			// Where should the gap go? Before the first row whose midpoint is below
			// the cursor (skip the placeholder itself); else the end.
			var ref = null;
			for ( var i = 0; i < items.length; i++ ) {
				if ( items[ i ] === d.row ) { continue; }
				var r = items[ i ].getBoundingClientRect();
				if ( clientY < r.top + r.height / 2 ) { ref = items[ i ]; break; }
			}
			// No-op if the placeholder is already there.
			if ( ref === d.row.nextElementSibling || ( ref === null && ! d.row.nextElementSibling ) ) { return; }

			// FLIP: record tops, move, then animate each row from old → new.
			var firsts = items.map( function ( it ) { return { el: it, top: it.getBoundingClientRect().top }; } );
			if ( ref ) { d.row.parentNode.insertBefore( d.row, ref ); }
			else { d.row.parentNode.appendChild( d.row ); }
			firsts.forEach( function ( f ) {
				var delta = f.top - f.el.getBoundingClientRect().top;
				if ( ! delta ) { return; }
				f.el.style.transition = 'none';
				f.el.style.transform = 'translateY(' + delta + 'px)';
				window.requestAnimationFrame( function () {
					f.el.style.transition = 'transform .16s ease';
					f.el.style.transform = '';
				} );
			} );
		},

		onNavDragUp: function () {
			var d = this._navDrag;
			if ( ! d ) { return; }
			window.removeEventListener( 'pointermove', d.move, true );
			window.removeEventListener( 'pointerup', d.up, true );
			window.removeEventListener( 'pointercancel', d.up, true );
			this._navDrag = null;

			if ( d.clone && d.clone.parentNode ) { d.clone.parentNode.removeChild( d.clone ); }
			d.row.classList.remove( 'fw-le-nav__placeholder' );
			this.$.nav.find( '.fw-le-nav__item' ).css( { transition: '', transform: '' } );
			if ( ! d.started ) { return; }

			// The placeholder is already in its final slot — commit that order.
			var next = d.row.nextElementSibling;
			var beforeId = next ? next.getAttribute( 'data-id' ) : null;
			this.moveSectionTo( d.id, beforeId );
		},

		/** Rebuild the navigator list from the current model order. */
		refreshNavigator: function () {
			if ( ! this.$.nav ) { return; }
			var $body = this.$.nav.find( '.fw-le-nav__body' ).empty();
			this.model.forEach( function ( item, idx ) {
				var id = ( item.atts && item.atts.unique_id ) || item.unique_id;
				if ( ! id ) { return; }
				var info = sectionMeta( item, idx );
				var $row = $(
					'<div class="fw-le-nav__item">' +
						'<span class="fw-le-nav__grip dashicons dashicons-menu" title="Drag to reorder"></span>' +
						'<span class="fw-le-nav__label"></span>' +
						'<span class="fw-le-nav__type"></span>' +
					'</div>'
				).attr( 'data-id', id );
				var $label = $row.find( '.fw-le-nav__label' )
					.text( info.label )
					.attr( 'title', ( cfg.l10n && cfg.l10n.renameTip ) || 'Double-click to rename' );
				if ( ! info.named ) { $label.addClass( 'fw-le-nav__label--placeholder' ); }
				if ( info.badge ) { $row.find( '.fw-le-nav__type' ).text( info.badge ); }
				else { $row.find( '.fw-le-nav__type' ).remove(); }
				$body.append( $row );
			} );
			if ( ! this.model.length ) {
				$body.append( '<div class="fw-le-nav__empty">' + ( ( cfg.l10n && cfg.l10n.noSections ) || 'No sections yet.' ) + '</div>' );
			}
		},

		/** Inline-rename a section from the navigator. The typed text is stored
		 *  verbatim as the section's CSS ID (so the modal Advanced tab shows it as
		 *  typed); the section view emits it as a normalized `id` (lowercase,
		 *  spaces → dashes). Re-renders the section so the new id takes effect. */
		renameSection: function ( rowEl, labelEl ) {
			if ( ! rowEl ) { return; }
			var id = rowEl.getAttribute( 'data-id' );
			var node = this.nodeOf( id );
			if ( ! node ) { return; }

			var self = this;
			var current = ( node.atts && node.atts.css_id ) || '';
			var $input = $( '<input type="text" class="fw-le-nav__rename" />' )
				.val( current )
				.attr( 'placeholder', 'Section name…' );
			$( labelEl ).replaceWith( $input );
			$input.trigger( 'focus' ).trigger( 'select' );

			var done = false;
			var commit = function ( save ) {
				if ( done ) { return; }
				done = true;
				if ( save ) {
					var val = $.trim( $input.val() );
					if ( ! node.atts ) { node.atts = {}; }
					if ( ( node.atts.css_id || '' ) !== val ) {
						self.recordHistory();
						node.atts.css_id = val;
						self.markDirty();
						self.renderItem( id ); // re-render so the output id updates
					}
				}
				self.refreshNavigator();
			};

			$input.on( 'blur', function () { commit( true ); } );
			$input.on( 'keydown', function ( ev ) {
				if ( ev.key === 'Enter' ) { ev.preventDefault(); commit( true ); }
				else if ( ev.key === 'Escape' ) { ev.preventDefault(); commit( false ); }
			} );
		},

		/** Reorder a top-level section to sit before `beforeId` (or end if null). */
		moveSectionTo: function ( id, beforeId ) {
			if ( ! id || id === beforeId ) { return; }
			var fromIdx = indexOfId( this.model, id );
			if ( fromIdx < 0 ) { return; }

			this.recordHistory();
			var node = this.model.splice( fromIdx, 1 )[ 0 ];
			var toIdx = beforeId ? indexOfId( this.model, beforeId ) : this.model.length;
			if ( toIdx < 0 ) { toIdx = this.model.length; }
			this.model.splice( toIdx, 0, node );

			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
			this.toFrame( 'move-section', { id: id, beforeId: beforeId || null } );
			this.refreshNavigator();
		},

		/* ---- builder templates (full / section / column) --------------- */

		/** Build the Templates side panel. Its body is filled on demand by
		 *  refreshTemplates() with the framework's standard templates HTML; all
		 *  clicks are delegated (bound once) so re-filling the body keeps working. */
		buildTemplatesPanel: function () {
			var l = cfg.l10n || {};
			var $panel = this.$.tpl = $(
				'<aside id="fw-le-templates">' +
					'<div class="fw-le-panel__head"><strong>' + ( l.templates || 'Templates' ) + '</strong>' +
						'<button type="button" class="fw-le-panel__close" aria-label="Close">&times;</button></div>' +
					'<div class="fw-le-tpl__body"></div>' +
				'</aside>'
			).appendTo( '#fw-live-editor-app' );

			$panel.find( '.fw-le-panel__close' ).on( 'click', function () { $( 'body' ).removeClass( 'fw-le-tpl-open' ); } );
			this.bindTemplatesPanel();
		},

		/** POST to admin-ajax for a builder-templates action. These handlers use
		 *  their own `_nonce` + `builder_type` (NOT the live-editor nonce), and
		 *  self-register on any admin-ajax request, so we can drive them directly. */
		tplAjax: function ( action, data, cb ) {
			$.post( cfg.ajaxUrl, $.extend( { action: action }, data ) )
				.done( cb )
				.fail( function ( xhr ) {
					window.console && console.error( '[fw-le-shell] tpl ajax error', action, xhr && xhr.status );
				} );
		},

		/** (Re)load the saved-templates list for all three types. */
		refreshTemplates: function () {
			var self = this, t = cfg.templates, l = cfg.l10n || {};
			var $body = this.$.tpl.find( '.fw-le-tpl__body' );
			$body.html( '<div class="fw-le-tpl__loading">' + ( l.templatesLoading || 'Loading templates…' ) + '</div>' );
			this.tplAjax( 'fw_builder_templates_render', {
				_nonce:       t.nonces.render,
				builder_type: t.builderType
			}, function ( json ) {
				if ( ! ( json && json.success && json.data && typeof json.data.html === 'string' ) ) {
					$body.html( '<div class="fw-le-tpl__error">' + ( l.templatesError || 'Could not load templates.' ) + '</div>' );
					window.console && console.error( '[fw-le-shell] templates render failed', json );
					return;
				}
				$body.html( json.data.html );
				self.decorateTemplates( $body );
			} );
		},

		/** Section/column accordions ship as "import-only" (their backend save is a
		 *  per-element control). In the live editor we add a Save button there that
		 *  captures the currently-selected section/column. */
		decorateTemplates: function ( $body ) {
			var l = cfg.l10n || {};
			// The render ships the first type expanded — sync the chevron state.
			$body.find( '.fw-builder-templates-type' ).each( function () {
				$( this ).toggleClass( 'is-open', ! $( this ).find( '> .fw-builder-templates-type-content' ).hasClass( 'fw-hidden' ) );
			} );
			[ [ 'section', l.saveSection || 'Save current section as Template' ],
			  [ 'column',  l.saveColumn  || 'Save current column as Template'  ] ].forEach( function ( pair ) {
				$body.find( '.fw-builder-templates-type-' + pair[ 0 ] + ' .save-template-wrapper' ).each( function () {
					if ( ! $( this ).find( 'a.save-template' ).length ) {
						$( '<a href="#" class="save-template button button-primary"></a> ' ).text( pair[ 1 ] ).prependTo( this );
					}
				} );
			} );
		},

		/** Bind every templates-panel interaction once (delegated on the body). */
		bindTemplatesPanel: function () {
			var self = this, t = cfg.templates;
			var $body = this.$.tpl.find( '.fw-le-tpl__body' );

			// Accordion: open the clicked type, collapse the others.
			$body.on( 'click', '.fw-builder-templates-type-title', function ( e ) {
				e.preventDefault();
				var $type    = $( this ).closest( '.fw-builder-templates-type' );
				var $content = $type.find( '> .fw-builder-templates-type-content' );
				var willOpen = $content.hasClass( 'fw-hidden' );
				$body.find( '.fw-builder-templates-type-content' ).addClass( 'fw-hidden' );
				$body.find( '.fw-builder-templates-type' ).removeClass( 'is-open' );
				if ( willOpen ) { $content.removeClass( 'fw-hidden' ); $type.addClass( 'is-open' ); }
			} );

			// Load a saved template → insert it into the page.
			$body.on( 'click', 'a[data-load-template]', function ( e ) {
				e.preventDefault();
				var type = tplTypeOf( $( this ) ), id = $( this ).attr( 'data-load-template' );
				if ( ! type ) { return; }
				self.tplAjax( 'fw_builder_templates_' + type + '_load', {
					_nonce: t.nonces[ type ], builder_type: t.builderType, template_id: id
				}, function ( json ) {
					if ( json && json.success && json.data && typeof json.data.json === 'string' ) {
						self.insertTemplate( type, json.data.json );
					} else {
						window.console && console.error( '[fw-le-shell] template load failed', json );
					}
				} );
			} );

			// Delete a saved template.
			$body.on( 'click', 'a[data-delete-template]', function ( e ) {
				e.preventDefault();
				var type = tplTypeOf( $( this ) ), id = $( this ).attr( 'data-delete-template' ), l = cfg.l10n || {};
				if ( ! type ) { return; }
				self.confirm( {
					title:       l.deleteTemplateTitle || 'Delete this template?',
					message:     l.deleteTemplateMsg || '',
					confirmText: 'Delete', danger: true
				}, function () {
					self.tplAjax( 'fw_builder_templates_' + type + '_delete', {
						_nonce: t.nonces[ type ], builder_type: t.builderType, template_id: id
					}, function ( json ) {
						if ( json && json.success ) { self.refreshTemplates(); }
						else { window.console && console.error( '[fw-le-shell] template delete failed', json ); }
					} );
				} );
			} );

			// Export a saved template → download the JSON envelope.
			$body.on( 'click', 'a[data-export-template]', function ( e ) {
				e.preventDefault();
				var type = tplTypeOf( $( this ) ), id = $( this ).attr( 'data-export-template' );
				if ( ! type ) { return; }
				self.tplAjax( 'fw_builder_templates_' + type + '_export', {
					_nonce: t.nonces[ type ], builder_type: t.builderType, template_id: id
				}, function ( json ) {
					if ( ! ( json && json.success && json.data && json.data.content ) ) {
						window.console && console.error( '[fw-le-shell] template export failed', json ); return;
					}
					var blob = new Blob( [ JSON.stringify( json.data.content, null, 2 ) ], { type: 'application/json' } );
					var url  = URL.createObjectURL( blob );
					var a    = document.createElement( 'a' );
					a.href = url; a.download = json.data.filename || 'template.json';
					document.body.appendChild( a ); a.click(); document.body.removeChild( a );
					window.setTimeout( function () { URL.revokeObjectURL( url ); }, 1000 );
				} );
			} );

			// Import: the link opens the hidden file input next to it.
			$body.on( 'click', 'a.import-template', function ( e ) {
				e.preventDefault();
				var $input = $( this ).closest( '.save-template-wrapper' ).find( 'input.template-import-file' );
				$input.val( '' ); $input.trigger( 'click' );
			} );
			$body.on( 'change', 'input.template-import-file', function () {
				var file = this.files && this.files[ 0 ];
				if ( ! file ) { return; }
				var type = tplTypeOf( $( this ) );
				if ( ! type ) { return; }
				var fd = new FormData();
				fd.append( 'action', 'fw_builder_templates_' + type + '_import' );
				fd.append( '_nonce', t.nonces[ type ] );
				fd.append( 'builder_type', t.builderType );
				fd.append( 'template_file', file );
				$.ajax( { type: 'post', dataType: 'json', url: cfg.ajaxUrl, data: fd, processData: false, contentType: false } )
					.done( function ( json ) {
						if ( json && json.success ) { self.refreshTemplates(); }
						else {
							window.alert( ( json && json.data && json.data.message ) || ( cfg.l10n && cfg.l10n.importFailed ) || 'Failed to import template' );
						}
					} )
					.fail( function () { window.alert( ( cfg.l10n && cfg.l10n.importFailed ) || 'Failed to import template' ); } );
			} );

			// Save the page / current section / current column as a template.
			$body.on( 'click', 'a.save-template', function ( e ) {
				e.preventDefault();
				var type = tplTypeOf( $( this ) );
				if ( type ) { self.saveTemplate( type ); }
			} );
		},

		/** Walk up from the current selection to the enclosing section (or null). */
		currentSectionNode: function () {
			var cur = this.selectedId, guard = 0;
			while ( cur && this.index[ cur ] && guard++ < 30 ) {
				var n = this.index[ cur ].node;
				if ( n && /section$/.test( n.type || '' ) ) { return n; }
				cur = this.index[ cur ].parentId;
			}
			return null;
		},

		/** Walk up from the current selection to the enclosing column (or null). */
		currentColumnNode: function () {
			var cur = this.selectedId, guard = 0;
			while ( cur && this.index[ cur ] && guard++ < 30 ) {
				var n = this.index[ cur ].node;
				if ( n && n.type === 'column' ) { return n; }
				cur = this.index[ cur ].parentId;
			}
			return null;
		},

		/** Prompt for a template name (reusing fw.OptionsModal, like the backend),
		 *  then cb(name). Falls back to window.prompt if the runtime is missing. */
		promptTemplateName: function ( cb ) {
			this.whenRuntimeReady( function ( ok ) {
				var l = cfg.l10n || {};
				if ( ! ok ) {
					var name = window.prompt( l.templateName || 'Template Name', '' );
					if ( name !== null ) { cb( name ); }
					return;
				}
				var modal = new fw.OptionsModal( {
					title:   l.saveTemplateTitle || 'Save Template',
					options: [ { 'template_name': { 'type': 'text', 'label': l.templateName || 'Template Name' } } ],
					values:  {}
				} );
				modal.on( 'change:values', function ( m, values ) { cb( ( values && values.template_name ) || '' ); } );
				modal.open();
			} );
		},

		/** Save the appropriate JSON for `type` as a new template. */
		saveTemplate: function ( type ) {
			var self = this, l = cfg.l10n || {};
			var jsonKey, jsonVal;

			if ( type === 'full' ) {
				jsonKey = 'builder_json'; jsonVal = JSON.stringify( this.model );
			} else if ( type === 'section' ) {
				var sec = this.currentSectionNode();
				if ( ! sec ) { window.alert( l.noSectionSelected || 'Select a section first.' ); return; }
				jsonKey = 'section_json'; jsonVal = JSON.stringify( sec );
			} else if ( type === 'column' ) {
				var col = this.currentColumnNode();
				if ( ! col ) { window.alert( l.noColumnSelected || 'Select a column first.' ); return; }
				jsonKey = 'column_json'; jsonVal = JSON.stringify( col );
			} else { return; }

			this.promptTemplateName( function ( name ) {
				var data = { _nonce: cfg.templates.nonces[ type ], builder_type: cfg.templates.builderType, template_name: name };
				data[ jsonKey ] = jsonVal;
				self.tplAjax( 'fw_builder_templates_' + type + '_save', data, function ( json ) {
					if ( json && json.success ) { self.refreshTemplates(); }
					else { window.console && console.error( '[fw-le-shell] template save failed', json ); }
				} );
			} );
		},

		/** Parse a loaded template's JSON and insert it for its granularity. */
		insertTemplate: function ( type, jsonStr ) {
			var parsed;
			try { parsed = JSON.parse( jsonStr ); }
			catch ( e ) { window.console && console.error( '[fw-le-shell] bad template json', e ); return; }
			if ( type === 'full' ) { this.insertFullTemplate( parsed ); }
			else if ( type === 'section' ) { this.insertSectionTemplate( parsed ); }
			else if ( type === 'column' ) { this.insertColumnTemplate( parsed ); }
		},

		/** Full template → replace the entire page (confirmed; undoable). */
		insertFullTemplate: function ( items ) {
			if ( ! Array.isArray( items ) ) { items = items ? [ items ] : []; }
			var self = this, l = cfg.l10n || {};
			this.confirm( {
				title:       l.replacePageTitle || 'Replace page with this template?',
				message:     l.replacePageMsg || '',
				confirmText: l.replacePageOk || 'Replace',
				danger:      true
			}, function () {
				self.recordHistory();
				// Fresh ids so the inserted tree can never collide with cached output.
				self.model = items.map( function ( it ) { return self.cloneWithNewIds( it ); } );
				self.rebuildIndex();
				self.markDirty();
				self.refreshNavigator();
				self.renderPageToCanvas();
				$( 'body' ).removeClass( 'fw-le-tpl-open' );
			} );
		},

		/** Section template → append a new section to the page. */
		insertSectionTemplate: function ( item ) {
			if ( ! item || typeof item !== 'object' ) { return; }
			var self = this;
			var node = this.cloneWithNewIds( item );
			var id   = ( node.atts && node.atts.unique_id ) || node.unique_id;
			var prevLast = this.model.length ? this.model[ this.model.length - 1 ] : null;
			var afterId  = prevLast ? ( ( prevLast.atts && prevLast.atts.unique_id ) || prevLast.unique_id ) : null;

			this.recordHistory();
			this.model.push( node );
			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
			this.refreshNavigator();
			this.ajax( cfg.actions.renderItem, { item: JSON.stringify( node ) }, function ( r ) {
				if ( r && r.success && r.data && typeof r.data.html === 'string' ) {
					self.toFrame( 'insert-section', { html: r.data.html, id: id, afterId: afterId } );
				} else {
					window.console && console.error( '[fw-le-shell] section template render failed', r );
				}
			} );
			$( 'body' ).removeClass( 'fw-le-tpl-open' );
		},

		/** Column template → add the column to the current (or last) section. */
		insertColumnTemplate: function ( item ) {
			if ( ! item || typeof item !== 'object' ) { return; }
			var self = this;
			var section = this.currentSectionNode() || ( this.model.length ? this.model[ this.model.length - 1 ] : null );
			if ( ! section || ! isContainer( section ) ) {
				window.alert( ( cfg.l10n && cfg.l10n.noSectionTarget ) || 'Add or select a section first.' ); return;
			}
			var sectionId = ( section.atts && section.atts.unique_id ) || section.unique_id;
			var col       = this.cloneWithNewIds( item );
			var newColId  = ( col.atts && col.atts.unique_id ) || col.unique_id;

			this.recordHistory();
			columnArrayOf( section ).push( col );
			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
			this.refreshNavigator();
			this.ajax( cfg.actions.renderItem, { item: JSON.stringify( section ) }, function ( r ) {
				if ( r && r.success && r.data && typeof r.data.html === 'string' ) {
					self.toFrame( 'replace', { id: sectionId, html: r.data.html, selectId: newColId } );
				} else {
					window.console && console.error( '[fw-le-shell] column template render failed', r );
				}
			} );
			$( 'body' ).removeClass( 'fw-le-tpl-open' );
		},

		/** Save a specific in-canvas item (section or column) as a template — the
		 *  in-canvas "Save as Template" control. Only sections + columns qualify. */
		saveItemAsTemplate: function ( id ) {
			var node = this.nodeOf( id );
			if ( ! node ) { return; }
			var t = cfg.templates;
			if ( ! ( t && t.enabled ) ) {
				window.alert( ( cfg.l10n && cfg.l10n.templatesError ) || 'Templates are unavailable.' ); return;
			}
			var type = /section$/.test( node.type || '' ) ? 'section'
				: ( node.type === 'column' ? 'column' : '' );
			if ( ! type ) { return; }

			var self = this;
			this.promptTemplateName( function ( name ) {
				var data = { _nonce: t.nonces[ type ], builder_type: t.builderType, template_name: name };
				data[ type + '_json' ] = JSON.stringify( node );
				self.tplAjax( 'fw_builder_templates_' + type + '_save', data, function ( json ) {
					if ( json && json.success ) {
						if ( $( 'body' ).hasClass( 'fw-le-tpl-open' ) ) { self.refreshTemplates(); }
					} else {
						window.console && console.error( '[fw-le-shell] save item template failed', json );
					}
				} );
			} );
		},

		/** Persist an item's per-device visibility via the standard `responsive_hide`
		 *  option ("Hide on" checkboxes). The frame toggled its dim + eye for the
		 *  previewed device optimistically; here we set/clear that device's hide key
		 *  in the model (which the save regenerates into the shortcode, where the
		 *  existing responsive-hide CSS honours it) and re-sync the frame so the
		 *  Advanced tab, undo/redo and save all stay consistent. */
		setItemHidden: function ( payload ) {
			payload = payload || {};
			var node = this.nodeOf( payload.id );
			if ( ! node ) { return; }
			var cls = DEVICE_HIDE[ payload.device ] || DEVICE_HIDE.desktop;
			if ( ! node.atts ) { node.atts = {}; }
			// responsive_hide is a checkboxes value: a MAP of { 'hide-xs': true, … }.
			// Its empty default arrives as a JS array ([]), and writing a string key
			// to an array is silently dropped on JSON.stringify — so only reuse it
			// when it's a real (non-array) object, else start a fresh map.
			var rh = ( node.atts.responsive_hide && ! Array.isArray( node.atts.responsive_hide )
				&& typeof node.atts.responsive_hide === 'object' )
				? node.atts.responsive_hide : {};
			var want = !! payload.hidden;
			if ( want === !! rh[ cls ] ) { return; }
			this.recordHistory();
			if ( want ) { rh[ cls ] = true; }
			else { delete rh[ cls ]; }
			node.atts.responsive_hide = rh;
			this.markDirty();
			this.syncFrameModel();
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

		/** Double-click an image → open the WP media library, swap the picked image
		 *  into the element's `image` upload value, and re-render it. Mirrors the
		 *  inline text-edit flow for direct, in-place image editing. */
		openImagePicker: function ( id ) {
			var node = this.nodeOf( id );
			if ( ! node ) { return; }
			if ( typeof wp === 'undefined' || ! wp.media ) {
				window.alert( 'The media library could not load. Please check the browser console.' );
				return;
			}

			var self    = this;
			var current = node.atts && node.atts.image;

			var frame = wp.media( {
				title:    ( cfg.l10n && cfg.l10n.selectImage ) || 'Select Image',
				button:   { text: ( cfg.l10n && cfg.l10n.useImage ) || 'Use this image' },
				library:  { type: 'image' },
				multiple: false
			} );

			// Preselect the current image in the library.
			frame.on( 'open', function () {
				if ( ! ( current && current.attachment_id ) ) { return; }
				var selection = frame.state().get( 'selection' );
				var attachment = wp.media.attachment( current.attachment_id );
				attachment.fetch();
				selection.add( attachment ? [ attachment ] : [] );
			} );

			frame.on( 'select', function () {
				var att = frame.state().get( 'selection' ).first();
				att = att ? att.toJSON() : null;
				if ( ! att || ! att.id ) { return; }

				self.recordHistory();
				if ( ! node.atts ) { node.atts = {}; }
				node.atts.image = {
					attachment_id: att.id,
					// Store protocol-relative, matching the upload option type.
					url: ( att.url || '' ).replace( /^https?:\/\//i, '//' )
				};
				self.markDirty();
				self.renderItem( id );
			} );

			frame.open();
		},

		/** Inline text edit committed (double-click). Store the HTML in the model;
		 *  the canvas already shows it, so no re-render is needed. */
		updateText: function ( payload ) {
			payload = payload || {};
			var node = this.nodeOf( payload.id );
			if ( ! node ) { return; }
			if ( ! node.atts ) { node.atts = {}; }
			if ( node.atts.text === payload.text ) { return; } // no change
			this.recordHistory();
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
			this.recordHistory();
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
			this.recordHistory();
			siblings.splice( pos + 1, 0, clone );

			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
			this.refreshNavigator();

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
			this.recordHistory();
			entry.siblings.splice( pos, 1 );

			this.rebuildIndex();
			this.markDirty();
			this.syncFrameModel();
			this.refreshNavigator();
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
				// A column dropped into a section lands in that section's column
				// array (which also handles a section that wraps columns in a row).
				if ( node.type === 'column' && /section$/.test( targetParent.node.type || '' ) ) {
					targetSiblings = columnArrayOf( targetParent.node );
				} else {
					if ( ! targetParent.node._items ) { targetParent.node._items = []; }
					targetSiblings = targetParent.node._items;
				}
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

			var snap = this.snapshot(); // pre-mutation, committed only on a real move
			oldSiblings.splice( from, 1 );
			if ( sameContainer && insertAt > from ) { insertAt--; }
			if ( sameContainer && insertAt === from ) {
				oldSiblings.splice( from, 0, node ); // back where it was → no change
				return;
			}

			this.recordHistory( snap );
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
			this.toFrame( 'set-device', { device: this.device || 'desktop' } );
		},

		/** Reflect the canvas selection as a clickable breadcrumb of the item's
		 *  ancestor chain (Section ▸ Column ▸ Element). Clicking a crumb selects
		 *  that ancestor — a quick way to step up from a nested element to its
		 *  column or section. */
		onSelect: function ( payload ) {
			var self = this;
			if ( ! this.$.breadcrumb ) {
				this.$.breadcrumb = $( '<span class="fw-le-breadcrumb" />' )
					.appendTo( '#fw-le-toolbar .fw-le-toolbar__group--left' );
				this.$.breadcrumb.on( 'click', '.fw-le-crumb:not(.is-active)', function () {
					self.toFrame( 'select-item', { id: this.getAttribute( 'data-id' ), scroll: false } );
				} );
			}

			this.$.breadcrumb.empty();
			var id = payload && payload.id;
			this.selectedId = ( id && this.index[ id ] ) ? id : null;
			if ( ! id || ! this.index[ id ] ) { return; }

			// Walk parentIds (root → selected).
			var chain = [], cur = id, guard = 0;
			while ( cur && this.index[ cur ] && guard++ < 30 ) {
				chain.unshift( { id: cur, label: labelFor( this.index[ cur ].node ) } );
				cur = this.index[ cur ].parentId;
			}

			chain.forEach( function ( c, i ) {
				self.$.breadcrumb.append( '<span class="fw-le-crumb-sep">▸</span>' );
				var $c = $( '<button type="button" class="fw-le-crumb" />' ).attr( 'data-id', c.id ).text( c.label );
				if ( i === chain.length - 1 ) { $c.addClass( 'is-active' ); }
				self.$.breadcrumb.append( $c );
			} );
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

				self.fetchOptions( tagFor( node ), function ( options, popupSize ) {
					if ( self.modal ) { try { self.modal.close(); } catch ( e ) {} }

					// Use the shortcode's own popup_size (matches the classic builder);
					// fall back to large for containers / medium for leaves.
					var size = ( popupSize === 'small' || popupSize === 'medium' || popupSize === 'large' )
						? popupSize
						: ( isContainer( node ) ? 'large' : 'medium' );

					self.log( 'opening modal for', id, 'with', ( options || [] ).length, 'option groups', 'size:', size );
					self.modal = new fw.OptionsModal( {
						title:   labelFor( node ),
						options: options,
						values:  node.atts || {},
						size:    size
					} );

					// One undo entry per edit session: snapshot the pre-edit model
					// now, and commit it to history only on the first real change.
					var preState = self.snapshot();
					var recorded = false;

					self.modal.on( 'change:values', function ( modal, values ) {
						if ( ! recorded ) { self.recordHistory( preState ); recorded = true; }
						node.atts = $.extend( {}, node.atts, values );
						self.markDirty();
						// Keep the canvas index in sync so modal edits (e.g. the "Hide
						// on" checkboxes, or a renamed css_id) are reflected by the eye /
						// dimming / labels — not just the re-rendered HTML.
						self.syncFrameModel();
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
					cb( resp.data.options, resp.data.popup_size || '' );
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

		/* ---- undo / redo ----------------------------------------------- */

		/** A deep, detached copy of the current model (the unit of history). */
		snapshot: function () {
			return JSON.parse( JSON.stringify( this.model ) );
		},

		/** Push a pre-mutation model state onto the undo stack (capping its size)
		 *  and clear the redo stack. Pass an explicit snapshot, or omit to capture
		 *  the current model now (call BEFORE the mutation). */
		recordHistory: function ( state ) {
			this.undoStack.push( state || this.snapshot() );
			if ( this.undoStack.length > HISTORY_MAX ) { this.undoStack.shift(); }
			this.redoStack.length = 0;
			this.refreshUndoRedo();
		},

		undo: function () {
			if ( ! this.undoStack.length ) { return; }
			this.redoStack.push( this.snapshot() );
			this.model = this.undoStack.pop();
			this.afterHistoryRestore();
		},

		redo: function () {
			if ( ! this.redoStack.length ) { return; }
			this.undoStack.push( this.snapshot() );
			this.model = this.redoStack.pop();
			this.afterHistoryRestore();
		},

		/** Rebuild index + re-render the whole canvas from the restored model. */
		afterHistoryRestore: function () {
			if ( this.modal ) { try { this.modal.close(); } catch ( e ) {} this.modal = null; }
			this.rebuildIndex();
			this.markDirty();
			this.refreshUndoRedo();
			this.refreshNavigator();
			this.renderPageToCanvas();
		},

		/** Server-render the entire model and swap it into the canvas wholesale —
		 *  the robust way to reflect an undo/redo regardless of which granular DOM
		 *  ops produced the change. */
		renderPageToCanvas: function () {
			var self = this;
			this.ajax( cfg.actions.renderPage, { json: JSON.stringify( this.model ) }, function ( r ) {
				if ( r && r.success && r.data && typeof r.data.html === 'string' ) {
					self.syncFrameModel();
					self.toFrame( 'render-page', { html: r.data.html } );
				} else {
					window.console && console.error( '[fw-le-shell] render-page failed', r );
				}
			} );
		},

		refreshUndoRedo: function () {
			if ( this.$.undo ) { this.$.undo.prop( 'disabled', ! this.undoStack.length ); }
			if ( this.$.redo ) { this.$.redo.prop( 'disabled', ! this.redoStack.length ); }
		},

		onKeydown: function ( e ) {
			if ( ! ( e.ctrlKey || e.metaKey ) ) { return; }
			// Let form fields (e.g. the options modal) keep their native undo.
			var t = e.target, tag = t && t.tagName;
			if ( tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ( t && t.isContentEditable ) ) { return; }
			var k = ( e.key || '' ).toLowerCase();
			if ( k === 'z' && ! e.shiftKey ) { e.preventDefault(); this.undo(); }
			else if ( k === 'y' || ( k === 'z' && e.shiftKey ) ) { e.preventDefault(); this.redo(); }
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

		/** Open the live page in a new tab. Shows the saved version — if there are
		 *  unsaved edits, Save first to see them on the page. */
		onPreview: function () {
			window.open( cfg.exitUrl || '/', '_blank', 'noopener' );
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
		},

		/** Switch the canvas to a device-preview width. The iframe's own viewport
		 *  width drives the page's media queries, so narrowing it shows the real
		 *  responsive layout. `desktop` fills the canvas; tablet/mobile center a
		 *  fixed-width frame. After resizing, the canvas selection overlay is stale,
		 *  so ask the frame to reposition it. */
		setDevice: function ( device ) {
			device = ( device === 'tablet' || device === 'mobile' ) ? device : 'desktop';
			this.device = device;
			$( 'body' )
				.removeClass( 'fw-le-device-desktop fw-le-device-tablet fw-le-device-mobile' )
				.addClass( 'fw-le-device-' + device );
			$( '#fw-le-devices .fw-le-device' ).each( function () {
				this.classList.toggle( 'is-active', this.getAttribute( 'data-device' ) === device );
			} );
			// Tell the canvas which device is previewed so the Hide/Show eye + the
			// dimming of hidden items track the current breakpoint.
			this.toFrame( 'set-device', { device: device } );
			// The iframe transition settles after ~250ms; nudge the overlay then.
			var self = this;
			window.setTimeout( function () { self.toFrame( 'reflow', {} ); }, 280 );
		}
	};

	$( function () {
		fwLiveEditor.init();
	} );

	window.fwLiveEditor = fwLiveEditor;

} )( jQuery );
