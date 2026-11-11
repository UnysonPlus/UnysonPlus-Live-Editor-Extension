/**
 * Live Editor — Interaction timeline (Animation Engine roadmap I4).
 *
 * A timeline docked under the canvas for the SELECTED element's Interactions (hover, click, load, in view,
 * scrolled past): one row per step, each drawn as a bar on a seconds axis exactly where the runtime will play
 * it (step order, "with / after the previous step", delay, duration and stagger across matched targets);
 * state steps show as a marker. Drag a bar to change the step's delay, drag its right edge to change its
 * duration (snapped to 0.05 s); the change is written to the page like any edit (undoable, Save to keep).
 * The playhead and Play run the sequence on the Edit canvas with temporary Web Animations on the real
 * targets, so it can be scrubbed frame by frame; closing the timeline puts every target back.
 *
 * Extends window.fwLiveEditor (live-editor.js) — loaded after it.
 */
( function ( $ ) {
	'use strict';

	var app = window.fwLiveEditor;
	if ( ! app || ! $ ) { return; }
	var cfg = window._fwLiveEditor || {};
	var L = function ( k, d ) { return ( cfg.l10n && cfg.l10n[ k ] ) || d; };

	var EASE = { out: 'cubic-bezier(.22,1,.36,1)', inout: 'cubic-bezier(.65,0,.35,1)', 'in': 'cubic-bezier(.64,0,.78,0)', back: 'cubic-bezier(.34,1.56,.64,1)', linear: 'linear' };
	var TRIG = { hover: 'On hover', click: 'On click', load: 'On page load', view: 'In view', past: 'Scrolled past' };
	var KEYS = [ 'upw_interactions', 'upw_interactions__2' ];
	var SNAP = 0.05;

	var tl = {
		open: false, $p: null, id: null, key: null, anims: [], total: 0, span: 1, t: 0, raf: 0,

		/** The selected node's active interactions: [ { key, mode, value } ]. */
		list: function ( node ) {
			var out = [];
			if ( ! node || ! node.atts ) { return out; }
			KEYS.forEach( function ( k ) {
				var v = node.atts[ k ];
				if ( v && v.mode && v.mode !== 'off' && v[ v.mode ] ) { out.push( { key: k, mode: v.mode, value: v } ); }
			} );
			return out;
		},
		num: function ( v, d ) { v = parseFloat( v ); return isNaN( v ) ? d : v; },
		frameDoc: function () { try { return app.$.frame[ 0 ].contentWindow.document; } catch ( e ) { return null; } },
		/** The selected element on the Edit canvas (its wrapper carries the interaction). */
		el: function () {
			var doc = this.frameDoc();
			var it = doc && this.id ? doc.querySelector( '[data-fw-item-id="' + this.id + '"]' ) : null;
			if ( ! it ) { return null; }
			return it.matches( '[data-upw-ix]' ) ? it : ( it.querySelector( '[data-upw-ix]' ) || it );
		},
		targets: function ( el, st ) {
			var doc = this.frameDoc(), tg = st.target || 'self', sel = String( st.selector || '' ).trim();
			try {
				if ( tg === 'self' ) { return [ el ]; }
				if ( tg === 'inside' ) { return sel ? [].slice.call( el.querySelectorAll( sel ) ) : [].slice.call( el.children ); }
				if ( tg === 'page' ) { return sel ? [].slice.call( doc.querySelectorAll( sel ) ) : []; }
			} catch ( e ) {}
			return [];
		},
		vals: function ( st ) {
			var k = {}, x = this.num( st.x, 0 ), y = this.num( st.y, 0 ), sc = this.num( st.scale, 1 ), r = this.num( st.rotate, 0 ), op = this.num( st.opacity, 1 ), bl = this.num( st.blur, 0 );
			if ( x || y ) { k.translate = x + 'px ' + y + 'px'; }
			if ( sc !== 1 ) { k.scale = String( sc ); }
			if ( r ) { k.rotate = r + 'deg'; }
			if ( op !== 1 ) { k.opacity = String( op ); }
			if ( bl ) { k.filter = 'blur(' + bl + 'px)'; }
			return k;
		},
		/** The same timing the runtime uses (upw-interactions.js build()), per step. */
		plan: function ( ix ) {
			var o = ix.value[ ix.mode ] || {}, steps = o.steps || {}, el = this.el(), self = this;
			var rows = [], t = 0, prevStart = 0, total = 0;
			[ 's1', 's2', 's3' ].forEach( function ( sk, i ) {
				var st = steps[ sk ] || {};
				var tg = st.target || ( i === 0 ? 'self' : 'none' );
				if ( tg === 'none' ) { return; }
				var isState = /^state_/.test( st.action || '' );
				var d = isState ? 0 : self.num( st.duration, 0.5 ), dl = self.num( st.delay, 0 ), stg = self.num( st.stagger, 0.08 );
				var nodes = el ? self.targets( el, st ) : [];
				var n = Math.max( 1, nodes.length );
				var base = st.start === 'with' ? prevStart : t;
				var start = base + dl;
				rows.push( { sk: sk, i: i, st: st, isState: isState, nodes: nodes, n: n, base: base, start: start, d: d, stg: stg } );
				total = Math.max( total, start + ( n - 1 ) * stg + d );
				prevStart = start;
				t = Math.max( t, start + ( n - 1 ) * stg + d );
			} );
			return { rows: rows, total: total };
		},
		label: function ( r ) {
			var st = r.st, tg = st.target || 'self';
			var who = tg === 'self' ? L( 'tlSelf', 'This element' ) : ( ( tg === 'inside' ? L( 'tlInside', 'Inside: ' ) : '' ) + ( st.selector || ( tg === 'inside' ? L( 'tlChildren', 'children' ) : '?' ) ) );
			var what;
			if ( r.isState ) {
				what = ( st.action === 'state_on' ? '→ ' : st.action === 'state_off' ? '← ' : '⇄ ' ) + ( st.state || '?' );
			} else {
				var bits = [], self = this;
				[ [ 'x', 'X', 0 ], [ 'y', 'Y', 0 ], [ 'scale', 'Scale', 1 ], [ 'rotate', 'Rotate', 0 ], [ 'opacity', 'Opacity', 1 ], [ 'blur', 'Blur', 0 ] ].forEach( function ( p ) {
					var v = self.num( st[ p[ 0 ] ], p[ 2 ] );
					if ( v !== p[ 2 ] ) { bits.push( p[ 1 ] + ' ' + v ); }
				} );
				what = ( st.direction === 'from' ? L( 'tlFrom', 'from ' ) : '' ) + ( bits.join( ', ' ) || '—' );
			}
			return { who: who + ( r.n > 1 ? ' ×' + r.n : '' ), what: what };
		},

		/* ---- panel ---- */
		toggle: function () { if ( this.open ) { this.close(); } else { this.show(); } },
		show: function () {
			if ( app.mode !== 'edit' ) { return; }
			this.open = true;
			$( 'body' ).addClass( 'fw-le-ixtl-open' );
			$( '#fw-le-ixtl-btn' ).addClass( 'is-active' ).attr( 'aria-pressed', 'true' );
			this.render();
		},
		close: function () {
			this.stop();
			this.clearPreview();
			this.open = false;
			$( 'body' ).removeClass( 'fw-le-ixtl-open' );
			$( '#fw-le-ixtl-btn' ).removeClass( 'is-active' ).attr( 'aria-pressed', 'false' );
			if ( this.$p ) { this.$p.remove(); this.$p = null; }
		},
		render: function () {
			if ( ! this.open ) { return; }
			this.stop();
			this.clearPreview();
			var self = this, node = app.selectedId ? app.nodeOf( app.selectedId ) : null, ixs = this.list( node );
			this.id = app.selectedId;
			if ( ! this.$p ) {
				this.$p = $( '<section id="fw-le-ixtl" class="fw-le-ixtl" aria-label="Interaction timeline"></section>' ).appendTo( '#fw-le-canvas' );
			}
			var $p = this.$p.empty();
			var $head = $( '<header class="fw-le-ixtl__head"></header>' ).appendTo( $p );
			$( '<strong class="fw-le-ixtl__title"></strong>' ).text( L( 'tlTitle', 'Interaction timeline' ) ).appendTo( $head );
			if ( ! ixs.length ) {
				$( '<span class="fw-le-ixtl__hint"></span>' ).text( node
					? L( 'tlNone', 'This element has no Interactions. Add one in its Animations tab (Add Animation → Interactions).' )
					: L( 'tlSelect', 'Select an element that has Interactions.' ) ).appendTo( $head );
				$( '<button type="button" class="fw-le-ixtl__close dashicons dashicons-no-alt" title="Close"></button>' ).on( 'click', function () { self.close(); } ).appendTo( $head );
				return;
			}
			if ( ! this.key || ! ixs.some( function ( x ) { return x.key === self.key; } ) ) { this.key = ixs[ 0 ].key; }
			var $tabs = $( '<span class="fw-le-ixtl__tabs" role="tablist"></span>' ).appendTo( $head );
			ixs.forEach( function ( x ) {
				$( '<button type="button" role="tab"></button>' ).text( TRIG[ x.mode ] || x.mode ).toggleClass( 'is-active', x.key === self.key )
					.attr( 'aria-selected', x.key === self.key ? 'true' : 'false' )
					.on( 'click', function () { self.key = x.key; self.render(); } ).appendTo( $tabs );
			} );
			var $ctl = $( '<span class="fw-le-ixtl__ctl"></span>' ).appendTo( $head );
			$( '<button type="button" class="fw-le-ixtl__play"><span class="dashicons dashicons-controls-play"></span>' + L( 'tlPlay', 'Play' ) + '</button>' ).on( 'click', function () { self.play(); } ).appendTo( $ctl );
			$( '<button type="button" class="fw-le-ixtl__reset" title="Back to the start"><span class="dashicons dashicons-controls-skipback"></span></button>' ).on( 'click', function () { self.seek( 0 ); } ).appendTo( $ctl );
			this.$time = $( '<span class="fw-le-ixtl__time">0.00 s</span>' ).appendTo( $ctl );
			$( '<button type="button" class="fw-le-ixtl__close dashicons dashicons-no-alt" title="Close"></button>' ).on( 'click', function () { self.close(); } ).appendTo( $head );

			var ix = ixs.filter( function ( x ) { return x.key === self.key; } )[ 0 ];
			var pl = this.plan( ix );
			this.ix = ix;
			this.total = pl.total;
			this.span = Math.max( 1, Math.ceil( ( pl.total + 0.4 ) * 2 ) / 2 );

			var $body = $( '<div class="fw-le-ixtl__body"></div>' ).appendTo( $p );
			var $axis = $( '<div class="fw-le-ixtl__axis"><span class="fw-le-ixtl__lbl"></span><div class="fw-le-ixtl__track fw-le-ixtl__ruler"></div></div>' ).appendTo( $body );
			var $ruler = $axis.find( '.fw-le-ixtl__ruler' );
			this.$ruler = $ruler;
			var stepT = this.span <= 2 ? 0.25 : ( this.span <= 5 ? 0.5 : 1 );
			for ( var s = 0; s <= this.span + 1e-6; s += stepT ) {
				$( '<i></i>' ).css( 'left', ( s / this.span * 100 ) + '%' ).attr( 'data-t', ( Math.round( s * 100 ) / 100 ) + 's' ).appendTo( $ruler );
			}
			pl.rows.forEach( function ( r ) {
				var lab = self.label( r );
				var $row = $( '<div class="fw-le-ixtl__row"></div>' ).appendTo( $body );
				var $l = $( '<span class="fw-le-ixtl__lbl"></span>' ).appendTo( $row );
				$( '<b></b>' ).text( L( 'tlStep', 'Step' ) + ' ' + ( r.i + 1 ) + ' · ' + lab.who ).appendTo( $l );
				$( '<em></em>' ).text( lab.what ).appendTo( $l );
				var $track = $( '<div class="fw-le-ixtl__track"></div>' ).appendTo( $row );
				var left = r.start / self.span * 100;
				if ( r.isState ) {
					$( '<span class="fw-le-ixtl__marker" title="State change"></span>' ).css( 'left', left + '%' ).appendTo( $track )
						.on( 'pointerdown', function ( e ) { self.drag( e, r, 'move', $track ); } );
					return;
				}
				var width = ( ( r.n - 1 ) * r.stg + r.d ) / self.span * 100;
				var $bar = $( '<span class="fw-le-ixtl__bar"></span>' ).css( { left: left + '%', width: Math.max( 0.6, width ) + '%' } ).appendTo( $track )
					.attr( 'title', ( Math.round( r.start * 100 ) / 100 ) + ' s → ' + ( Math.round( ( r.start + ( r.n - 1 ) * r.stg + r.d ) * 100 ) / 100 ) + ' s' );
				for ( var k = 1; k < r.n && r.stg > 0; k++ ) {
					$( '<i class="fw-le-ixtl__tick"></i>' ).css( 'left', ( k * r.stg / ( ( r.n - 1 ) * r.stg + r.d ) * 100 ) + '%' ).appendTo( $bar );
				}
				$( '<span class="fw-le-ixtl__grip" title="Drag to change the duration"></span>' ).appendTo( $bar )
					.on( 'pointerdown', function ( e ) { e.stopPropagation(); self.drag( e, r, 'size', $track ); } );
				$bar.on( 'pointerdown', function ( e ) { self.drag( e, r, 'move', $track ); } );
			} );
			this.$head = $( '<div class="fw-le-ixtl__playhead"></div>' ).appendTo( $body );
			$ruler.on( 'pointerdown', function ( e ) { self.scrubFrom( e, $ruler ); } );
			this.buildPreview( pl );
			this.seek( 0 );
		},

		/* ---- editing ---- */
		drag: function ( e, r, kind, $track ) {
			e.preventDefault();
			var self = this, w = $track.width() || 1, x0 = e.clientX;
			var st0 = this.num( r.st.delay, 0 ), d0 = this.num( r.st.duration, 0.5 );
			var pre = app.snapshot(), changed = false;
			this.dragging = true;
			var snap = function ( v ) { return Math.max( 0, Math.round( v / SNAP ) * SNAP ); };
			var move = function ( ev ) {
				var dt = ( ev.clientX - x0 ) / w * self.span;
				var node = app.nodeOf( self.id ), v = node && node.atts && node.atts[ self.key ];
				var st = v && v[ v.mode ] && v[ v.mode ].steps && v[ v.mode ].steps[ r.sk ];
				if ( ! st ) { return; }
				if ( kind === 'move' ) { st.delay = Math.round( snap( st0 + dt ) * 100 ) / 100; } else { st.duration = Math.round( Math.max( SNAP, snap( d0 + dt ) ) * 100 ) / 100; }
				changed = true;
				self.render();
			};
			var up = function () {
				document.removeEventListener( 'pointermove', move );
				document.removeEventListener( 'pointerup', up );
				self.dragging = false;
				if ( ! changed ) { return; }
				app.recordHistory( pre );
				app.markDirty();
				app.syncFrameModel();
				app.renderItem( self.id );
				// The canvas re-renders the element; rebuild the preview on the new markup once it lands.
				window.setTimeout( function () { if ( self.open ) { self.render(); } }, 900 );
			};
			document.addEventListener( 'pointermove', move );
			document.addEventListener( 'pointerup', up );
		},

		/* ---- preview on the Edit canvas ---- */
		buildPreview: function ( pl ) {
			var self = this, total = pl.total;
			pl.rows.forEach( function ( r ) {
				if ( r.isState ) { return; }
				var vals = self.vals( r.st );
				if ( ! Object.keys( vals ).length ) { return; }
				var kf = r.st.direction === 'from' ? [ Object.assign( { offset: 0 }, vals ) ] : [ Object.assign( { offset: 1 }, vals ) ];
				r.nodes.forEach( function ( n, i ) {
					var at = ( r.start + i * r.stg ) * 1000, dur = r.d * 1000;
					try {
						var a = n.animate( kf, { duration: Math.max( 1, dur ), delay: at, endDelay: Math.max( 0, total * 1000 - at - dur ), easing: EASE[ r.st.ease ] || EASE.out, fill: 'both' } );
						a.pause();
						self.anims.push( a );
					} catch ( e ) {}
				} );
			} );
		},
		clearPreview: function () {
			this.anims.forEach( function ( a ) { try { a.cancel(); } catch ( e ) {} } );
			this.anims = [];
		},
		seek: function ( t ) {
			this.t = Math.max( 0, Math.min( this.span, t ) );
			var ms = Math.min( this.t, this.total ) * 1000;
			this.anims.forEach( function ( a ) { try { a.currentTime = ms; } catch ( e ) {} } );
			if ( this.$head && this.$ruler && this.$ruler[ 0 ] ) {
				var rl = this.$ruler[ 0 ];
				this.$head.css( 'left', ( rl.offsetLeft + rl.offsetWidth * ( this.t / this.span ) ) + 'px' );
			}
			if ( this.$time ) { this.$time.text( this.t.toFixed( 2 ) + ' s' ); }
		},
		scrubFrom: function ( e, $ruler ) {
			e.preventDefault();
			this.stop();
			var self = this, off = $ruler.offset().left, w = $ruler.width() || 1;
			var at = function ( ev ) { self.seek( ( ev.clientX - off ) / w * self.span ); };
			at( e );
			var up = function () { document.removeEventListener( 'pointermove', at ); document.removeEventListener( 'pointerup', up ); };
			document.addEventListener( 'pointermove', at );
			document.addEventListener( 'pointerup', up );
		},
		play: function () {
			this.stop();
			var self = this, from = this.t >= this.total - 1e-3 ? 0 : this.t, t0 = performance.now();
			var tick = function ( now ) {
				var t = from + ( now - t0 ) / 1000;
				self.seek( t );
				if ( t < self.total ) { self.raf = window.requestAnimationFrame( tick ); } else { self.raf = 0; }
			};
			this.raf = window.requestAnimationFrame( tick );
		},
		stop: function () { if ( this.raf ) { window.cancelAnimationFrame( this.raf ); this.raf = 0; } }
	};

	app.ixTimeline = tl;

	// A contextual pill on the canvas (top right), shown while the selected element has Interactions: the
	// toolbar is already full, and the timeline only means something for such an element.
	tl.pill = function () {
		var node = app.selectedId ? app.nodeOf( app.selectedId ) : null;
		var show = app.mode === 'edit' && ( tl.open || tl.list( node ).length > 0 );
		var $b = $( '#fw-le-ixtl-btn' );
		if ( ! $b.length && show ) {
			$b = $( '<button type="button" id="fw-le-ixtl-btn" class="fw-le-ixtl-btn" aria-pressed="false"></button>' )
				.attr( 'title', L( 'tlButton', 'Interaction timeline: see and retime the selected element’s Interactions, and scrub them on the canvas' ) )
				.html( '<span class="dashicons dashicons-editor-alignleft"></span>' + L( 'tlShort', 'Interaction timeline' ) )
				.on( 'click', function () { tl.toggle(); } )
				.appendTo( '#fw-le-canvas' );
		}
		$b.toggle( show ).toggleClass( 'is-active', tl.open ).attr( 'aria-pressed', tl.open ? 'true' : 'false' );
	};
	var origSelect = app.onSelect;
	app.onSelect = function () {
		var r = origSelect.apply( this, arguments );
		if ( tl.open && this.selectedId !== tl.id ) { tl.key = null; tl.render(); }
		tl.pill();
		return r;
	};
	var origShow = tl.show, origClose = tl.close;
	tl.show = function () { origShow.apply( tl, arguments ); tl.pill(); };
	tl.close = function () { origClose.apply( tl, arguments ); tl.pill(); };
	var origMode = app.setMode;
	app.setMode = function ( mode ) {
		if ( mode === 'preview' && tl.open ) { tl.close(); }
		var r = origMode.apply( this, arguments );
		tl.pill();
		return r;
	};
	// Any history change (an edit in the options, undo, redo) can change the steps: redraw while open.
	// (refreshUndoRedo runs after every one of them; the buttons call bound copies of undo / redo.)
	var origRefresh = app.refreshUndoRedo, redrawT = 0;
	app.refreshUndoRedo = function () {
		var r = origRefresh.apply( this, arguments );
		tl.pill();
		if ( tl.open && ! tl.dragging ) {
			window.clearTimeout( redrawT );
			redrawT = window.setTimeout( function () { tl.render(); }, 80 );
		}
		return r;
	};
} )( window.jQuery );
