/**
 * Live Editor — the Animate workspace (Animation Creator A2).
 *
 * A second way of working in the Live Editor, beside Design: the page stays in the middle (held still, selectable
 * only), the Navigator on the left, a timeline docked under the canvas, and a side panel on the right that shows only
 * the tools for what is selected:
 *
 *   nothing selected            → the timeline: name, Plays on and its options, length, loop, Runs on, Import / Export
 *   an element not in it        → Animate this element (a track with a first move); tracks not on this page to move here
 *   an element in it            → its values at the playhead (a change adds or updates a keyframe there)
 *   a keyframe (on the dock)    → its time, values and the curve into it
 *
 * The data is the page timeline the Animation Engine plays for visitors (modules/page-timelines): saved with the
 * page's own Save (one Save, one undo), played on the canvas by the same runtime (upw-timeline.js) through the
 * `upw-timeline` frame message. Curves come from the shared curve list (cfg.easeCss / cfg.animCurves), each keyframe
 * carrying its curve as CSS (`e`) so the runtime needs no curve library.
 *
 * Extends window.fwLiveEditor (live-editor.js) — loaded after it.
 */
( function ( $ ) {
	'use strict';

	var app = window.fwLiveEditor;
	var cfg = window._fwLiveEditor || {};
	if ( ! app || ! $ || ! cfg.canTimelines ) { return; }
	var L = function ( k, d ) { return ( cfg.l10n && cfg.l10n[ k ] ) || d; };

	var PROPS = [
		{ k: 'x', label: 'Move X', unit: '%', rest: 0, step: 1 },
		{ k: 'y', label: 'Move Y', unit: '%', rest: 0, step: 1 },
		{ k: 'scale', label: 'Scale', unit: '×', rest: 1, step: 0.05, min: 0 },
		{ k: 'rotate', label: 'Rotate', unit: '°', rest: 0, step: 1 },
		{ k: 'opacity', label: 'Opacity', unit: '', rest: 1, step: 0.05, min: 0, max: 1 },
		{ k: 'blur', label: 'Blur', unit: '', rest: 0, step: 0.1, min: 0 },
	];
	var TRIGGERS = [
		{ v: 'load', label: 'Page load', hint: 'Plays when the page opens' },
		{ v: 'in-view', label: 'In view', hint: 'Plays when its element scrolls into view' },
		{ v: 'hover', label: 'Hover', hint: 'Plays while the pointer is over its element, and back when it leaves' },
		{ v: 'click', label: 'Click', hint: 'Plays when its element is clicked' },
		{ v: 'scroll', label: 'Scroll', hint: 'The scroll position is the playhead: it plays forward as you scroll down and back as you scroll up' },
	];
	var DEVICES = [ { v: 'desktop', label: 'Desktop' }, { v: 'tablet', label: 'Tablet' }, { v: 'phone', label: 'Phone' } ];
	var EASE_CSS = cfg.easeCss || {};
	var CURVES = cfg.animCurves || [];
	var DEF_EASE = EASE_CSS.soft_land ? 'soft_land' : 'out';
	var SNAP = 0.05, NEAR = 0.005;
	/** Starting points (5g): ready-made moves for a new track. Curves are keys from the shared list. */
	var STARTS = [
		{ id: 'rise', name: 'Rise in', frames: [ { t: 0, y: 30, opacity: 0 }, { t: 0.6, y: 0, opacity: 1, ease: 'soft_land' } ] },
		{ id: 'fade', name: 'Fade in', frames: [ { t: 0, opacity: 0 }, { t: 0.5, opacity: 1, ease: 'soft_in_out' } ] },
		{ id: 'left', name: 'Slide in from the left', frames: [ { t: 0, x: -30, opacity: 0 }, { t: 0.6, x: 0, opacity: 1, ease: 'soft_land' } ] },
		{ id: 'right', name: 'Slide in from the right', frames: [ { t: 0, x: 30, opacity: 0 }, { t: 0.6, x: 0, opacity: 1, ease: 'soft_land' } ] },
		{ id: 'drop', name: 'Drop in', frames: [ { t: 0, y: -40, opacity: 0 }, { t: 0.7, y: 0, opacity: 1, ease: 'bounce_hard' } ] },
		{ id: 'pop', name: 'Pop in', frames: [ { t: 0, scale: 0.6, opacity: 0 }, { t: 0.6, scale: 1, opacity: 1, ease: 'pop_over' } ] },
		{ id: 'blur', name: 'Blur in', frames: [ { t: 0, blur: 1.2, scale: 1.05, opacity: 0 }, { t: 0.7, blur: 0, scale: 1, opacity: 1, ease: 'glide' } ] },
		{ id: 'spin', name: 'Spin in', frames: [ { t: 0, rotate: -90, scale: 0.7, opacity: 0 }, { t: 0.7, rotate: 0, scale: 1, opacity: 1, ease: 'pop_over' } ] },
		{ id: 'swing', name: 'Swing (attention)', frames: [ { t: 0, rotate: 0 }, { t: 0.2, rotate: 8, ease: 'soft_in_out' }, { t: 0.4, rotate: -6, ease: 'soft_in_out' }, { t: 0.6, rotate: 3, ease: 'soft_in_out' }, { t: 0.8, rotate: 0, ease: 'soft_in_out' } ] },
		{ id: 'pulse', name: 'Pulse (attention)', frames: [ { t: 0, scale: 1 }, { t: 0.3, scale: 1.08, ease: 'soft_in_out' }, { t: 0.6, scale: 1, ease: 'soft_in_out' } ] },
		{ id: 'lift', name: 'Lift (for hover)', frames: [ { t: 0, y: 0, scale: 1 }, { t: 0.35, y: -6, scale: 1.03, ease: 'pop_over' } ] },
	];

	var r3 = function ( v ) { return Math.round( v * 1000 ) / 1000; };
	var num = function ( v ) { return typeof v === 'number' && isFinite( v ); };
	var esc = function ( s ) { return $( '<i>' ).text( String( s == null ? '' : s ) ).html(); };
	/** Kinetic Scenes wrote curve names in camelCase (softLand); the shared list uses soft_land. */
	var ekey = function ( n ) { return String( n || '' ).replace( /([a-z0-9])([A-Z])/g, '$1_$2' ).toLowerCase(); };
	var ecss = function ( key ) { key = ekey( key ); return key === 'linear' ? 'linear' : ( EASE_CSS[ key ] || '' ); };
	var curveLabel = function ( key ) {
		key = ekey( key );
		for ( var i = 0; i < CURVES.length; i++ ) { if ( CURVES[ i ].key === key ) { return CURVES[ i ].label; } }
		return key ? key.replace( /_/g, ' ' ) : L( 'animLinear', 'Linear' );
	};

	/* ---- curves, for the values at the playhead (the runtime's own maths) ---- */
	var FN = {};
	function easeFn( css ) {
		css = String( css || '' ).trim();
		if ( ! css || css === 'linear' ) { return null; }
		if ( FN[ css ] ) { return FN[ css ]; }
		var m, f = null;
		if ( ( m = /^linear\(([^)]*)\)$/.exec( css ) ) ) {
			var pts = m[ 1 ].split( ',' ).map( function ( p ) { return Number( p.trim().split( /\s+/ )[ 0 ] ); } );
			f = function ( t ) {
				if ( t <= 0 ) { return pts[ 0 ]; } if ( t >= 1 ) { return pts[ pts.length - 1 ]; }
				var x = t * ( pts.length - 1 ), i = Math.floor( x );
				return pts[ i ] + ( pts[ i + 1 ] - pts[ i ] ) * ( x - i );
			};
		} else if ( ( m = /^cubic-bezier\(([^)]*)\)$/.exec( css ) ) ) {
			var c = m[ 1 ].split( ',' ).map( Number );
			var bx = function ( t ) { var u = 1 - t; return 3 * c[ 0 ] * t * u * u + 3 * c[ 2 ] * t * t * u + t * t * t; };
			var by = function ( t ) { var u = 1 - t; return 3 * c[ 1 ] * t * u * u + 3 * c[ 3 ] * t * t * u + t * t * t; };
			f = function ( x ) { var lo = 0, hi = 1; for ( var s = 0; s < 24; s++ ) { var mid = ( lo + hi ) / 2; if ( bx( mid ) < x ) { lo = mid; } else { hi = mid; } } return by( ( lo + hi ) / 2 ); };
		}
		return ( FN[ css ] = f );
	}
	function valueAt( frames, k, t ) {
		var keyed = frames.filter( function ( f ) { return num( f[ k ] ); } );
		if ( ! keyed.length ) { return undefined; }
		if ( t <= keyed[ 0 ].t ) { return keyed[ 0 ][ k ]; }
		var last = keyed[ keyed.length - 1 ];
		if ( t >= last.t ) { return last[ k ]; }
		for ( var n = 1; n < keyed.length; n++ ) {
			if ( keyed[ n ].t > t ) {
				var a = keyed[ n - 1 ], b = keyed[ n ], p = ( t - a.t ) / ( b.t - a.t ), fn = easeFn( b.e || ecss( b.ease ) );
				if ( fn ) { p = fn( p ); }
				return a[ k ] + ( b[ k ] - a[ k ] ) * p;
			}
		}
		return last[ k ];
	}

	/* ---- files: JSON (every setting) and CSV (a spreadsheet, one row per keyframe) ---- */
	var COLS = [ 'timeline_id', 'timeline', 'plays_on', 'length', 'started_by', 'once', 'leave', 'toggle', 'threshold', 'delay', 'pin', 'screens', 'repeat', 'yoyo', 'runs_on', 'element', 'element_name', 'track_curve', 'stagger', 'order', 't', 'x', 'y', 'scale', 'rotate', 'opacity', 'blur', 'curve' ];
	var cell = function ( v ) { var s = v == null ? '' : String( v ); return /[",\n\r]/.test( s ) ? '"' + s.replace( /"/g, '""' ) + '"' : s; };
	function toCsv( list ) {
		var rows = [ COLS.join( ',' ) ];
		list.forEach( function ( tl ) {
			var g = tl.trigger || {};
			var base = [ tl.id, tl.name, g.type, tl.duration, g.target || '', g.once === false ? 'no' : '', g.leave || '', g.toggle ? 'yes' : '', num( g.threshold ) ? g.threshold : '', num( g.delay ) ? g.delay : '', g.pin ? 'yes' : '', num( g.length ) ? g.length : '', tl.repeat || '', tl.yoyo ? 'yes' : '', ( tl.runsOn || [] ).join( ' ' ) ];
			tl.tracks.forEach( function ( tr ) {
				tr.frames.forEach( function ( f ) {
					rows.push( base.concat( [ tr.target, tr.label || '', tr.ease || '', tr.stagger || '', tr.order || '', f.t ], PROPS.map( function ( p ) { return num( f[ p.k ] ) ? f[ p.k ] : ''; } ), [ f.ease || '' ] ).map( cell ).join( ',' ) );
				} );
			} );
		} );
		return rows.join( '\r\n' ) + '\r\n';
	}
	function parseCsv( text ) {
		var rows = [], row = [], cur = '', q = false;
		for ( var i = 0; i < text.length; i++ ) {
			var c = text[ i ];
			if ( q ) { if ( c === '"' && text[ i + 1 ] === '"' ) { cur += '"'; i++; } else if ( c === '"' ) { q = false; } else { cur += c; } }
			else if ( c === '"' ) { q = true; }
			else if ( c === ',' ) { row.push( cur ); cur = ''; }
			else if ( c === '\n' || c === '\r' ) { if ( c === '\r' && text[ i + 1 ] === '\n' ) { i++; } row.push( cur ); cur = ''; if ( row.some( Boolean ) ) { rows.push( row ); } row = []; }
			else { cur += c; }
		}
		row.push( cur ); if ( row.some( Boolean ) ) { rows.push( row ); }
		return rows;
	}
	function fromCsv( text ) {
		var rows = parseCsv( text.replace( /^﻿/, '' ) );
		if ( rows.length < 2 ) { return []; }
		var head = rows[ 0 ].map( function ( h ) { return h.trim().toLowerCase(); } );
		var at = function ( r, k ) { var i = head.indexOf( k ); return i >= 0 ? String( r[ i ] || '' ).trim() : ''; };
		var nv = function ( v ) { return v === '' ? undefined : Number( v ); };
		var by = {}, order = [];
		rows.slice( 1 ).forEach( function ( r ) {
			var id = at( r, 'timeline_id' ) || at( r, 'timeline' );
			if ( ! id ) { return; }
			var tl = by[ id ];
			if ( ! tl ) {
				var trig = { type: at( r, 'plays_on' ) || 'load' };
				if ( at( r, 'started_by' ) ) { trig.target = at( r, 'started_by' ); }
				if ( at( r, 'once' ) === 'no' ) { trig.once = false; }
				if ( at( r, 'leave' ) === 'stay' ) { trig.leave = 'stay'; }
				if ( at( r, 'toggle' ) === 'yes' ) { trig.toggle = true; }
				if ( at( r, 'threshold' ) !== '' ) { trig.threshold = Number( at( r, 'threshold' ) ); }
				if ( at( r, 'delay' ) !== '' ) { trig.delay = Number( at( r, 'delay' ) ); }
				if ( at( r, 'pin' ) === 'yes' ) { trig.pin = true; }
				if ( at( r, 'screens' ) !== '' ) { trig.length = Number( at( r, 'screens' ) ); }
				tl = by[ id ] = { id: id, name: at( r, 'timeline' ) || 'Page timeline', duration: nv( at( r, 'length' ) ) || 2, trigger: trig, tracks: [] };
				if ( nv( at( r, 'repeat' ) ) ) { tl.repeat = nv( at( r, 'repeat' ) ); }
				if ( at( r, 'yoyo' ) === 'yes' ) { tl.yoyo = true; }
				var runs = at( r, 'runs_on' ).split( /[\s;|]+/ ).filter( function ( d ) { return /^(desktop|tablet|phone)$/.test( d ); } );
				if ( runs.length ) { tl.runsOn = runs; }
				order.push( id );
			}
			var target = at( r, 'element' ), t = nv( at( r, 't' ) );
			if ( ! target || t === undefined || ! isFinite( t ) ) { return; }
			var tr = tl.tracks.filter( function ( x ) { return x.target === target; } )[ 0 ];
			if ( ! tr ) {
				tr = { target: target, frames: [] };
				if ( at( r, 'element_name' ) ) { tr.label = at( r, 'element_name' ); }
				if ( at( r, 'track_curve' ) ) { tr.ease = at( r, 'track_curve' ); }
				if ( nv( at( r, 'stagger' ) ) ) { tr.stagger = nv( at( r, 'stagger' ) ); }
				if ( /^(last|center|random)$/.test( at( r, 'order' ) ) ) { tr.order = at( r, 'order' ); }
				tl.tracks.push( tr );
			}
			var f = { t: t };
			PROPS.forEach( function ( p ) { var v = nv( at( r, p.k ) ); if ( v !== undefined && isFinite( v ) ) { f[ p.k ] = v; } } );
			if ( at( r, 'curve' ) ) { f.ease = at( r, 'curve' ); }
			tr.frames.push( f );
		} );
		return order.map( function ( id ) { return by[ id ]; } );
	}
	function download( name, text, type ) {
		var url = URL.createObjectURL( new Blob( [ text ], { type: type } ) );
		var a = document.createElement( 'a' ); a.href = url; a.download = name;
		document.body.appendChild( a ); a.click(); a.remove();
		setTimeout( function () { URL.revokeObjectURL( url ); }, 1000 );
	}
	var slug = function ( s, d ) { return String( s || '' ).toLowerCase().replace( /[^a-z0-9]+/g, '-' ).replace( /^-|-$/g, '' ) || d; };

	/* ---- the workspace ---- */
	var A = {
		on: false, list: [], activeId: '', t: 0, raf: 0, kf: null, zoom: 1, previewing: false, tlDirty: false, settings: false,
		presets: [], start: 'rise',

		/** A timeline as stored, made editable: curve names in the shared list's form, frames in time order. */
		clean: function ( tl ) {
			tl = $.extend( true, {}, tl );
			tl.trigger = tl.trigger || { type: 'load' };
			tl.duration = Math.max( 0.2, Number( tl.duration ) || 2 );
			tl.tracks = ( tl.tracks || [] ).map( function ( tr ) {
				if ( tr.ease ) { tr.ease = ekey( tr.ease ); }
				tr.frames = ( tr.frames || [] ).map( function ( f ) { if ( f.ease ) { f.ease = ekey( f.ease ); } return f; } ).sort( function ( a, b ) { return a.t - b.t; } );
				return tr;
			} );
			return tl;
		},
		active: function () { var id = this.activeId; return this.list.filter( function ( t ) { return t.id === id; } )[ 0 ] || null; },
		isClass: function ( target ) { return /^\.[A-Za-z_-][A-Za-z0-9_-]*$/.test( String( target || '' ) ); },
		/** The classes an element was given (Advanced › CSS class), for "Animate every .class". */
		classesOf: function ( id ) {
			var node = app.nodeOf( id ), raw = node && node.atts && typeof node.atts.css_class === 'string' ? node.atts.css_class : '';
			return raw.split( /\s+/ ).filter( function ( c ) { return /^[A-Za-z_-][A-Za-z0-9_-]*$/.test( c ) && ! /^(upw-|fw-|sc-)/.test( c ); } );
		},
		frameDoc: function () { try { return app.$.frame[ 0 ].contentDocument; } catch ( e ) { return null; } },
		matches: function ( cls ) { var d = this.frameDoc(); try { return d ? [].slice.call( d.querySelectorAll( cls ) ) : []; } catch ( e ) { return []; } },
		firstIdOf: function ( cls ) {
			var m = this.matches( cls ).map( function ( el ) { return el.closest( '[data-fw-item-id]' ); } ).filter( Boolean )[ 0 ];
			return m ? m.getAttribute( 'data-fw-item-id' ) : '';
		},
		/** Is a track's target on this page? (an element, or at least one element with its class) */
		present: function ( tr ) { return this.isClass( tr.target ) ? this.matches( tr.target ).length > 0 : !! app.nodeOf( tr.target ); },
		/** The track that moves an element: its own, or the track of a class it has. */
		trackFor: function ( id ) {
			var own = this.track( id );
			if ( own || ! id ) { return own; }
			var cls = this.classesOf( id ), tl = this.active();
			return tl ? tl.tracks.filter( function ( tr ) { return cls.indexOf( String( tr.target ).slice( 1 ) ) >= 0 && tr.target[ 0 ] === '.'; } )[ 0 ] || null : null;
		},
		track: function ( target ) { var tl = this.active(); return tl ? tl.tracks.filter( function ( t ) { return t.target === target; } )[ 0 ] || null : null; },
		newTimeline: function () {
			var n = this.list.length + 1;
			return { id: 'tl-' + Math.random().toString( 36 ).slice( 2, 8 ), name: L( 'animTimeline', 'Timeline' ) + ' ' + n, duration: 2, trigger: { type: 'load' }, tracks: [] };
		},
		/** Everything to save: timelines with a track, each keyframe with its curve as CSS. */
		forSave: function ( site ) {
			return this.list.filter( function ( tl ) { return tl.tracks.length && ( site === undefined || !! tl.site === site ); } ).map( function ( tl ) {
				var out = $.extend( true, {}, tl );
				out.tracks.forEach( function ( tr ) {
					tr.frames.forEach( function ( f ) {
						var css = f.ease ? ecss( f.ease ) : ( tr.ease ? ecss( tr.ease ) : '' );
						if ( css ) { f.e = css; } else if ( f.ease ) { delete f.e; }
					} );
				} );
				return out;
			} );
		},
		nameOf: function ( id ) {
			var node = app.nodeOf( id );
			if ( ! node ) { return null; }
			var a = node.atts || {}, raw = '';
			[ 'title', 'heading', 'text', 'content', 'label', 'button_text', 'name' ].some( function ( k ) { if ( typeof a[ k ] === 'string' && a[ k ].trim() ) { raw = a[ k ]; return true; } return false; } );
			var txt = $( '<div>' ).html( raw ).text().replace( /\s+/g, ' ' ).trim().slice( 0, 40 );
			return ( app.labelFor ? app.labelFor( node ) : ( node.shortcode || node.type ) ) + ( txt ? ' · ' + txt : '' );
		},
		trackName: function ( tr ) {
			if ( this.isClass( tr.target ) ) { var n = this.matches( tr.target ).length; return L( 'animEvery', 'Every' ) + ' ' + tr.target + ' (' + n + ')'; }
			return this.nameOf( tr.target ) || ( ( tr.label || L( 'animElement', 'Element' ) ) + ' ' + L( 'animNotHere', '(not on this page)' ) );
		},

		/* -- history: timeline changes share the editor's undo stack -- */
		snap: function () { return { __tl: JSON.stringify( { list: this.list, activeId: this.activeId } ) }; },
		restore: function ( e ) { var d = JSON.parse( e.__tl ); this.list = d.list; this.activeId = d.activeId; this.kf = null; this.changed( true ); },
		/** Record the state before a change, then make it. */
		commit: function ( fn ) {
			app.undoStack.push( this.snap() );
			if ( app.undoStack.length > 100 ) { app.undoStack.shift(); }
			app.redoStack.length = 0;
			fn();
			this.changed();
		},
		changed: function () {
			this.tlDirty = true;
			this.previewing = false;
			app.markDirty();
			app.refreshUndoRedo();
			var tl = this.active();
			if ( tl && this.t > tl.duration ) { this.t = tl.duration; }
			this.push();
			this.render();
		},

		/* -- the canvas -- */
		push: function () {
			if ( ! this.on ) { return; }
			app.toFrame( 'upw-timeline', { op: 'update', timelines: this.forSave().concat( this.list.filter( function ( t ) { return ! t.tracks.length; } ) ), id: this.activeId, t: this.t } );
		},
		seek: function ( t, keepPlaying ) {
			var tl = this.active();
			if ( ! tl ) { return; }
			if ( ! keepPlaying ) { this.stop(); }
			this.t = r3( Math.max( 0, Math.min( tl.duration, t ) ) );
			this.previewing = false;
			app.toFrame( 'upw-timeline', { op: 'seek', id: tl.id, t: this.t } );
			this.drawPlayhead();
			var $f = $( document.activeElement ).closest( '#fw-le-anim-panel' );
			if ( ! $f.length ) { this.renderPanel(); }
		},
		play: function () {
			var tl = this.active(), self = this;
			if ( ! tl || ! tl.tracks.length ) { return; }
			if ( this.raf ) { this.stop(); return; }
			if ( this.t >= tl.duration - 0.01 ) { this.t = 0; }
			var last = 0;
			var step = function ( now ) {
				if ( ! last ) { last = now; }
				var dt = Math.min( 0.5, ( now - last ) / 1000 ); last = now;
				var t = self.t + dt;
				if ( t >= tl.duration ) { self.raf = 0; self.seek( tl.duration ); self.renderBar(); return; }
				self.seek( t, true );
				self.raf = requestAnimationFrame( step );
			};
			this.raf = requestAnimationFrame( step );
			this.renderBar();
		},
		stop: function () { if ( this.raf ) { cancelAnimationFrame( this.raf ); this.raf = 0; this.renderBar(); } },
		preview: function () {
			var tl = this.active();
			if ( ! tl || ! tl.tracks.length ) { return; }
			this.stop();
			if ( this.previewing ) { this.previewing = false; this.seek( this.t ); this.renderBar(); return; }
			this.previewing = true;
			app.toFrame( 'upw-timeline', { op: 'arm', id: tl.id } );
			this.renderBar();
		},
		select: function ( id ) { if ( id && app.nodeOf( id ) ) { app.toFrame( 'select-item', { id: id, scroll: true } ); } },

		/* -- entering and leaving -- */
		enter: function () {
			if ( this.on ) { return; }
			if ( app.mode !== 'edit' ) { app.setMode( 'edit' ); }
			this.on = true;
			if ( ! this.list.length ) { this.list = [ this.newTimeline() ]; }
			if ( ! this.active() ) { this.activeId = this.list[ 0 ].id; }
			this.navWasOpen = $( 'body' ).hasClass( 'fw-le-nav-open' );
			$( '#fw-le-ixtl .fw-le-ixtl__close' ).first().trigger( 'click' );
			$( 'body' ).removeClass( 'fw-le-panel-open fw-le-tpl-open fw-le-history-open' ).addClass( 'fw-le-anim fw-le-nav-open' );
			if ( app.refreshNavigator ) { app.refreshNavigator(); }
			this.build();
			this.toFrame();
			this.render();
			this.switcher();
			var self = this; setTimeout( function () { self.follow(); }, 50 );
		},
		leave: function () {
			if ( ! this.on ) { return; }
			this.stop();
			this.on = false;
			this.previewing = false;
			app.toFrame( 'upw-timeline', { op: 'clear' } );
			app.toFrame( 'set-animate', { on: false } );
			$( 'body' ).removeClass( 'fw-le-anim' ).toggleClass( 'fw-le-nav-open', !! this.navWasOpen );
			this.switcher();
		},
		toFrame: function () {
			if ( ! this.on ) { return; }
			app.toFrame( 'set-animate', { on: true } );
			this.push();
			// Follow the page: scrolling the canvas brings up the timeline of the section in view.
			var doc = this.frameDoc(), w = doc && doc.defaultView, self = this;
			if ( w && ! w.__upwFollow ) {
				w.__upwFollow = true;
				var h = 0;
				w.addEventListener( 'scroll', function () { clearTimeout( h ); h = setTimeout( function () { self.follow(); }, 180 ); }, { passive: true } );
			}
		},

		/* -- follow the page (the user's idea, 2026-11-20) --
		 * The timeline you edit follows the canvas: when most of a section is in view (60% of it, or of the screen for a
		 * tall one), the timeline that moves that section's elements becomes the one in the picker. It only changes on a
		 * scroll, so a timeline picked by hand stays until the next scroll; never while playing, previewing or dragging. */
		trackIn: function ( tl, id ) {
			var cls = this.classesOf( id );
			return tl.tracks.filter( function ( tr ) { return tr.target === id || ( tr.target[ 0 ] === '.' && cls.indexOf( tr.target.slice( 1 ) ) >= 0 ); } )[ 0 ] || null;
		},
		sectionsOf: function ( tl ) {
			var doc = this.frameDoc(), self = this, out = [];
			if ( ! doc ) { return out; }
			tl.tracks.forEach( function ( tr ) {
				var els = self.isClass( tr.target ) ? self.matches( tr.target ) : [ doc.querySelector( '[data-fw-item-id="' + String( tr.target ).replace( /["\\]/g, '' ) + '"]' ) ];
				els.forEach( function ( el ) {
					if ( ! el ) { return; }
					var sec = el.closest( 'section, .upw-section' ) || el;
					if ( out.indexOf( sec ) < 0 ) { out.push( sec ); }
				} );
			} );
			return out;
		},
		follow: function () {
			if ( ! this.on || this.raf || this.previewing || this.dragging || ! $( '#fw-le-workspace [data-ws="animate"]' ).hasClass( 'is-active' ) ) { return; }
			var doc = this.frameDoc(), vh = doc && doc.defaultView.innerHeight, self = this, best = null;
			if ( ! vh ) { return; }
			this.list.forEach( function ( tl ) {
				self.sectionsOf( tl ).forEach( function ( sec ) {
					var r = sec.getBoundingClientRect(), seen = Math.max( 0, Math.min( r.bottom, vh ) - Math.max( r.top, 0 ) );
					var share = seen / Math.max( 1, Math.min( r.height, vh ) );
					// Ties (two timelines in one section) keep the one you are on.
					if ( share >= 0.6 && ( ! best || share > best.share + 0.001 || ( Math.abs( share - best.share ) <= 0.001 && tl.id === self.activeId ) ) ) {
						best = { id: tl.id, share: share };
					}
				} );
			} );
			if ( best && best.id !== this.activeId ) { this.switchTo( best.id ); }
		},
		switchTo: function ( id ) {
			if ( id === this.activeId ) { return; }
			this.stop();
			this.activeId = id; this.kf = null; this.t = 0; this.previewing = false;
			this.push(); this.render();
			var $tl = $( '#fw-le-anim-bar .fw-le-anim-bar__tl' );
			$tl.addClass( 'is-followed' ); setTimeout( function () { $tl.removeClass( 'is-followed' ); }, 700 );
		},

		/* -- building the chrome -- */
		switcher: function () {
			var $s = $( '#fw-le-workspace' ), self = this;
			if ( ! $s.length ) {
				$s = $( '<div id="fw-le-workspace" class="fw-le-devices fw-le-workspace" role="group"></div>' ).attr( 'aria-label', L( 'animWorkspace', 'Workspace' ) );
				$( '<button type="button" class="fw-le-device fw-le-mode" data-ws="design"><span class="dashicons dashicons-admin-appearance"></span><span class="fw-le-mode__lbl"></span></button>' )
					.attr( 'title', L( 'animDesignTip', 'Design: build and edit the page' ) ).find( '.fw-le-mode__lbl' ).text( L( 'animDesign', 'Design' ) ).end()
					.on( 'click', function () { self.leave(); } ).appendTo( $s );
				$( '<button type="button" class="fw-le-device fw-le-mode" data-ws="animate"><span class="dashicons dashicons-controls-play"></span><span class="fw-le-mode__lbl"></span></button>' )
					.attr( 'title', L( 'animAnimateTip', 'Animate: move elements of this page on a timeline' ) ).find( '.fw-le-mode__lbl' ).text( L( 'animAnimate', 'Animate' ) ).end()
					.on( 'click', function () { self.enter(); } ).appendTo( $s );
				$s.prependTo( '#fw-le-toolbar .fw-le-toolbar__group--center' );
			}
			$s.find( '[data-ws]' ).each( function () {
				var on = ( this.getAttribute( 'data-ws' ) === 'animate' ) === self.on;
				$( this ).toggleClass( 'is-active', on ).attr( 'aria-pressed', on ? 'true' : 'false' );
			} );
		},
		build: function () {
			var self = this;
			if ( ! $( '#fw-le-anim-bar' ).length ) {
				var $b = $( '<div id="fw-le-anim-bar" class="fw-le-anim-bar"></div>' ).insertAfter( '#fw-le-workspace' );
				$b.on( 'change', '.fw-le-anim-bar__tl', function () { self.switchTo( this.value ); } );
				$b.on( 'click', '.fw-le-anim-bar__new', function () { self.stop(); self.commit( function () { var tl = self.newTimeline(); self.list.push( tl ); self.activeId = tl.id; self.kf = null; self.t = 0; } ); } );
				$b.on( 'click', '.fw-le-anim-bar__play', function () { self.play(); } );
				$b.on( 'click', '.fw-le-anim-bar__start', function () { self.seek( 0 ); } );
				$b.on( 'click', '.fw-le-anim-bar__preview', function () { self.preview(); } );
				// Scroll tools (A5): the page as a visitor sees it, with the Scroll Ruler and the Scroll Timeline on it.
				$b.on( 'click', '.fw-le-anim-bar__scroll', function () { app.scrollTools = true; app.setMode( 'preview' ); } );
			}
			if ( ! $( '#fw-le-anim-panel' ).length ) {
				var $p = $( '<aside id="fw-le-anim-panel" class="fw-le-anim-panel"></aside>' ).attr( 'aria-label', L( 'animPanel', 'Animate' ) ).appendTo( '#fw-live-editor-app' );
				this.bindPanel( $p );
			}
			if ( ! $( '#fw-le-anim-dock' ).length ) {
				var $d = $( '<section id="fw-le-anim-dock" class="fw-le-anim-dock"></section>' ).attr( 'aria-label', L( 'animTimeline', 'Timeline' ) ).appendTo( '#fw-live-editor-app' );
				this.bindDock( $d );
			}
		},
		render: function () { if ( ! this.on ) { return; } this.renderBar(); this.renderPanel(); this.renderDock(); },

		renderBar: function () {
			var $b = $( '#fw-le-anim-bar' ), tl = this.active();
			if ( ! $b.length || ! tl ) { return; }
			var opts = this.list.map( function ( t ) { return '<option value="' + esc( t.id ) + '"' + ( t.id === tl.id ? ' selected' : '' ) + '>' + esc( t.name ) + ' (' + t.tracks.length + ')' + ( t.site ? ' · ' + esc( L( 'animEveryPage', 'every page' ) ) : '' ) + '</option>'; } ).join( '' );
			$b.html(
				'<select class="fw-le-anim-bar__tl" title="' + esc( L( 'animPick', 'The timeline you are editing. It follows the page: scroll to a section and its timeline comes up.' ) ) + '">' + opts + '</select>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-bar__new" title="' + esc( L( 'animNewTip', 'A new timeline for this page' ) ) + '"><span class="dashicons dashicons-plus-alt2"></span></button>' +
				'<span class="fw-le-anim-bar__sep"></span>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-bar__start" title="' + esc( L( 'animStart', 'Back to the start' ) ) + '"><span class="dashicons dashicons-controls-skipback"></span></button>' +
				'<button type="button" class="fw-le-btn fw-le-anim-bar__play' + ( this.raf ? ' is-on' : '' ) + '"' + ( tl.tracks.length ? '' : ' disabled' ) + ' title="' + esc( L( 'animPlayTip', 'Play the timeline on the page (Space)' ) ) + '"><span class="dashicons dashicons-controls-' + ( this.raf ? 'pause' : 'play' ) + '"></span></button>' +
				'<span class="fw-le-anim-bar__time">' + this.t.toFixed( 2 ) + ' / ' + tl.duration.toFixed( 2 ) + ' s</span>' +
				'<span class="fw-le-anim-bar__sep"></span>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-bar__preview' + ( this.previewing ? ' is-on' : '' ) + '"' + ( tl.tracks.length ? '' : ' disabled' ) + ' title="' + esc( L( 'animPreviewTip', 'Play it on the page as a visitor gets it: it waits for its trigger (hover the element, click it, scroll it into view)' ) ) + '"><span class="dashicons dashicons-visibility"></span> <span class="fw-le-anim-bar__lbl">' + esc( this.previewing ? L( 'animPreviewing', 'Waiting…' ) : L( 'animPreview', 'Preview' ) ) + '</span></button>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-bar__scroll" title="' + esc( L( 'animScrollTip', 'Scroll tools: the page as a visitor sees it (every scroll animation running), with the Scroll Ruler and the Scroll Timeline to read and retime the scroll motion. Edit or Animate brings you back.' ) ) + ' aria-label="' + esc( L( 'animScrollTools', 'Scroll tools' ) ) + '"><span class="dashicons dashicons-image-flip-vertical"></span></button>'
			);
		},

		/* -- the side panel -- */
		renderPanel: function () {
			var $p = $( '#fw-le-anim-panel' ), tl = this.active();
			if ( ! $p.length || ! tl ) { return; }
			var id = app.selectedId && app.nodeOf( app.selectedId ) ? String( app.selectedId ) : '';
			var tr = id ? this.trackFor( id ) : null, h;
			if ( this.kf && ( ! this.track( this.kf.target ) || ! this.track( this.kf.target ).frames[ this.kf.i ] ) ) { this.kf = null; }
			if ( this.kf ) { h = this.panelKeyframe( tl, this.track( this.kf.target ), this.kf.i ); }
			else if ( id && ! this.settings ) { h = tr ? this.panelTrack( tl, tr ) : this.panelElement( tl, id ); }
			else { h = this.panelTimeline( tl ); }
			$p.html( h );
		},
		head: function ( title, back ) {
			return '<header class="fw-le-anim-panel__head">' + ( back ? '<button type="button" class="fw-le-anim-link" data-act="settings">‹ ' + esc( L( 'animTimelineSettings', 'Timeline' ) ) + '</button>' : '' ) + '<strong>' + esc( title ) + '</strong></header>';
		},
		row: function ( label, control, hint ) { return '<label class="fw-le-anim-field"><span>' + esc( label ) + '</span>' + control + ( hint ? '<em>' + esc( hint ) + '</em>' : '' ) + '</label>'; },
		panelTimeline: function ( tl ) {
			var g = tl.trigger, self = this, h = this.head( L( 'animTimeline', 'Timeline' ), false );
			h += this.row( L( 'animName', 'Name' ), '<input type="text" data-tl="name" maxlength="80" value="' + esc( tl.name ) + '">' );
			h += this.row( L( 'animPlaysOn', 'Plays on' ), '<select data-tl="trigger.type">' + TRIGGERS.map( function ( x ) { return '<option value="' + x.v + '"' + ( x.v === g.type ? ' selected' : '' ) + ' title="' + esc( x.hint ) + '">' + esc( x.label ) + '</option>'; } ).join( '' ) + '</select>' );
			if ( g.type !== 'load' ) {
				var opts = '<option value="">' + esc( L( 'animFirstTrack', 'Its first track’s element' ) ) + '</option>' + tl.tracks.map( function ( tr ) { return '<option value="' + esc( tr.target ) + '"' + ( g.target === tr.target ? ' selected' : '' ) + '>' + esc( self.trackName( tr ) ) + '</option>'; } ).join( '' );
				if ( g.target && ! tl.tracks.some( function ( tr ) { return tr.target === g.target; } ) ) { opts += '<option value="' + esc( g.target ) + '" selected>' + esc( this.nameOf( g.target ) || g.target ) + '</option>'; }
				h += this.row( g.type === 'in-view' ? L( 'animWhenInView', 'When this is in view' ) : g.type === 'hover' ? L( 'animWhenHover', 'When the pointer is over' ) : g.type === 'scroll' ? L( 'animWhenScroll', 'While this scrolls by' ) : L( 'animWhenClick', 'When this is clicked' ), '<select data-tl="trigger.target">' + opts + '</select>', L( 'animStartsHint', 'Or select an element on the page and use “Starts the timeline”.' ) );
			}
			var chk = function ( key, on, label ) { return '<label class="fw-le-anim-check"><input type="checkbox" data-tl="' + key + '"' + ( on ? ' checked' : '' ) + '> ' + esc( label ) + '</label>'; };
			var checks = '';
			if ( g.type === 'hover' ) { checks += chk( 'trigger.leave', g.leave !== 'stay', L( 'animLeave', 'Play back on leaving' ) ); }
			if ( g.type === 'click' ) { checks += chk( 'trigger.toggle', !! g.toggle, L( 'animToggle', 'Clicks go forward, then back' ) ); }
			if ( g.type === 'in-view' ) { checks += chk( 'trigger.once', g.once === false, L( 'animEveryTime', 'Every time it comes into view' ) ); }
			if ( g.type === 'load' || g.type === 'click' ) { checks += chk( 'repeat', tl.repeat === -1, L( 'animLoop', 'Loop' ) ); }
			if ( ( g.type === 'load' || g.type === 'click' ) && tl.repeat === -1 ) { checks += chk( 'yoyo', !! tl.yoyo, L( 'animYoyo', 'Back and forth' ) ); }
			if ( g.type === 'scroll' ) { checks += chk( 'trigger.pin', !! g.pin, L( 'animPin', 'Pin it: hold it in place while the timeline plays' ) ); }
			if ( checks ) { h += '<div class="fw-le-anim-checks">' + checks + '</div>'; }
			if ( g.type === 'scroll' ) {
				if ( g.pin ) { h += this.row( L( 'animPinLength', 'Pinned for (screen heights)' ), '<input type="number" data-tl="trigger.length" min="0.5" max="10" step="0.5" value="' + ( g.length || 2 ) + '">' ); }
				h += '<p class="fw-le-anim-note">' + esc( g.pin ? L( 'animScrollPinHint', 'The element holds at the top of the screen while the visitor scrolls this far; the timeline runs from start to end over that distance, and back when they scroll up.' ) : L( 'animScrollHint', 'The timeline runs while the element crosses the screen: its start as the element comes in at the bottom, its end as it leaves at the top. Scrolling back plays it back.' ) ) + '</p>';
			}
			h += this.row( L( 'animLength', 'Length (s)' ), '<input type="number" data-tl="duration" min="0.2" max="120" step="0.1" value="' + tl.duration + '">' );
			if ( cfg.canSite ) {
				var me3 = this, allClass = tl.tracks.length && tl.tracks.every( function ( tr ) { return me3.isClass( tr.target ); } ) && ( ! g.target || this.isClass( g.target ) );
				h += '<label class="fw-le-anim-check fw-le-anim-site"><input type="checkbox" data-site' + ( tl.site ? ' checked' : '' ) + ( allClass || tl.site ? '' : ' disabled' ) + '> ' + esc( L( 'animSite', 'Use on every page' ) ) + '</label>';
				h += '<p class="fw-le-anim-note">' + esc( tl.site ? L( 'animSiteOn', 'Site-wide: it plays on every page of the site that has these classes, and changes here change it everywhere.' ) : allClass ? L( 'animSiteCan', 'Every track is a class track, so it can play on every page.' ) : L( 'animSiteNo', 'Only a timeline made of class tracks (Animate every “.class”) can play on every page.' ) ) + '</p>';
			}
			var runs = tl.runsOn || [ 'desktop', 'tablet', 'phone' ];
			h += '<fieldset class="fw-le-anim-devices"><legend>' + esc( L( 'animRunsOn', 'Runs on' ) ) + '</legend>' + DEVICES.map( function ( d ) { return '<label><input type="checkbox" data-dev="' + d.v + '"' + ( runs.indexOf( d.v ) >= 0 ? ' checked' : '' ) + '> ' + esc( d.label ) + '</label>'; } ).join( '' ) + '</fieldset>';
			if ( ! runs.length ) { h += '<p class="fw-le-anim-note is-warn">' + esc( L( 'animNoDevice', 'It runs on no device: tick at least one.' ) ) + '</p>'; }
			var me2 = this, away = tl.tracks.filter( function ( tr ) { return ! me2.present( tr ); } );
			if ( away.length ) { h += '<p class="fw-le-anim-note is-warn">' + esc( away.length + ' ' + L( 'animAwayN', 'track(s) point at elements not on this page. Select an element to give it one of them.' ) ) + '</p>'; }
			h += '<p class="fw-le-anim-note">' + esc( tl.tracks.length ? L( 'animHowTracks', 'Select an element on the page to animate it or change its moves. Click a diamond on the timeline to change a keyframe.' ) : L( 'animHowStart', 'Select an element on the page (or in the Structure list), then “Animate this element”.' ) ) + '</p>';
			h += '<details class="fw-le-anim-io"' + ( this.ioOpen ? ' open' : '' ) + '><summary>' + esc( L( 'animIO', 'Import / Export' ) ) + '</summary><div class="fw-le-anim-io__row">' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost" data-act="export-one"' + ( tl.tracks.length ? '' : ' disabled' ) + '>' + esc( L( 'animExportOne', 'This timeline (JSON)' ) ) + '</button>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost" data-act="export-all">' + esc( L( 'animExportAll', 'All (JSON)' ) ) + '</button>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost" data-act="export-csv">' + esc( L( 'animExportCsv', 'All (CSV)' ) ) + '</button>' +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost" data-act="import">' + esc( L( 'animImport', 'Import a file…' ) ) + '</button>' +
				'<input type="file" accept=".json,.csv,application/json,text/csv" hidden></div><p class="fw-le-anim-note">' + esc( L( 'animIONote', 'JSON keeps every setting, to move timelines to another page or site (All also carries your presets). CSV is a spreadsheet (one row per keyframe) that imports back the same.' ) ) + '</p>' + ( this.ioNote ? '<p class="fw-le-anim-note" role="status">' + esc( this.ioNote ) + '</p>' : '' ) + '</details>';
			h += '<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-danger" data-act="delete-tl">' + esc( L( 'animDeleteTl', 'Delete this timeline' ) ) + '</button>';
			return h;
		},
		panelElement: function ( tl, id ) {
			var self = this, h = this.head( this.nameOf( id ), true );
			h += this.row( L( 'animStartWith', 'Start with' ), this.startSelect() );
			h += '<button type="button" class="fw-le-btn fw-le-btn--primary fw-le-anim-wide" data-act="add">' + esc( L( 'animAddThis', 'Animate this element' ) ) + '</button>';
			h += '<p class="fw-le-anim-note">' + esc( L( 'animAddHint', 'It gets a track in “' ) + tl.name + L( 'animAddHint2', '” with those moves, ready to change.' ) ) + '</p>';
			var classes = this.classesOf( id ), me = this;
			if ( classes.length ) {
				h += classes.map( function ( c ) {
					var n = me.matches( '.' + c ).length;
					return '<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-wide" data-act="add-class" data-cls="' + esc( c ) + '">' + esc( L( 'animAddEvery', 'Animate every' ) + ' “.' + c + '” (' + n + ')' ) + '</button>';
				} ).join( '' );
				h += '<p class="fw-le-anim-note">' + esc( L( 'animClassHint', 'One track for every element with the class, one after another (set the stagger once it is added).' ) ) + '</p>';
			} else {
				h += '<p class="fw-le-anim-note">' + esc( L( 'animNoClass', 'To animate every element like this one at once, give them a class (the element’s Advanced › CSS class).' ) ) + '</p>';
			}
			if ( tl.trigger.type !== 'load' && tl.trigger.target !== id ) {
				h += '<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-wide" data-act="starts">' + esc( L( 'animStarts', 'Starts the timeline' ) ) + '</button>';
			}
			var away = tl.tracks.filter( function ( tr ) { return ! self.present( tr ) && ! self.isClass( tr.target ); } );
			if ( away.length ) {
				h += '<div class="fw-le-anim-away"><strong>' + esc( L( 'animAway', 'Not on this page' ) ) + '</strong>' + away.map( function ( tr ) {
					return '<div><span>' + esc( tr.label || L( 'animElement', 'Element' ) ) + '</span><button type="button" class="fw-le-btn fw-le-btn--ghost" data-act="retarget" data-from="' + esc( tr.target ) + '">' + esc( L( 'animUseThis', 'Use this element' ) ) + '</button></div>';
				} ).join( '' ) + '</div>';
			}
			h += this.otherTimelines( tl, id );
			return h;
		},
		otherTimelines: function ( tl, id ) {
			var others = this.list.filter( function ( t ) { return t.id !== tl.id && t.tracks.some( function ( tr ) { return tr.target === id; } ); } );
			return others.length ? '<p class="fw-le-anim-note">' + esc( L( 'animAlsoIn', 'Also moved by: ' ) + others.map( function ( t ) { return t.name; } ).join( ', ' ) ) + '</p>' : '';
		},
		panelTrack: function ( tl, tr ) {
			var self = this, t = this.t, h = this.head( this.trackName( tr ), true );
			var here = tr.frames.filter( function ( f ) { return Math.abs( f.t - t ) < NEAR; } )[ 0 ];
			h += '<p class="fw-le-anim-sub">' + esc( ( here ? '◆ ' + L( 'animKeyAt', 'Keyframe at ' ) : L( 'animAt', 'At ' ) ) + t.toFixed( 2 ) + ' s' ) + '</p>';
			if ( ! here ) {
				h += '<button type="button" class="fw-le-btn fw-le-btn--primary fw-le-anim-wide" data-act="add-kf" data-target="' + esc( tr.target ) + '">◆ ' + esc( L( 'animAddKf', 'Add a keyframe at' ) + ' ' + t.toFixed( 2 ) + ' s' ) + '</button>';
			}
			PROPS.forEach( function ( p ) {
				var v = valueAt( tr.frames, p.k, t ), keyed = here && num( here[ p.k ] );
				h += '<label class="fw-le-anim-prop' + ( keyed ? ' is-keyed' : '' ) + '"><span>' + ( keyed ? '◆ ' : '' ) + esc( p.label ) + '</span><input type="number" data-prop="' + p.k + '" step="' + p.step + '"' + ( p.min != null ? ' min="' + p.min + '"' : '' ) + ( p.max != null ? ' max="' + p.max + '"' : '' ) + ' value="' + ( v === undefined ? p.rest : r3( v ) ) + '"><i>' + esc( p.unit ) + '</i></label>';
			} );
			h += '<p class="fw-le-anim-note">' + esc( L( 'animPropHint', 'To key another moment: move the playhead (click the ruler at the top of the timeline), then change a value or add a keyframe. Double-click a row on the timeline, or press K, to add one there.' ) ) + '</p>';
			if ( this.isClass( tr.target ) ) {
				var ord = tr.order || 'first';
				h += this.row( L( 'animStagger', 'Stagger (s)' ), '<input type="number" data-cl="stagger" min="0" max="5" step="0.05" value="' + ( tr.stagger || 0 ) + '">', L( 'animStaggerHint', 'Each element starts this long after the one before. The values above are the first element’s.' ) );
				h += this.row( L( 'animOrder', 'Order' ), '<select data-cl="order">' + [ [ 'first', L( 'animOrderFirst', 'First to last' ) ], [ 'last', L( 'animOrderLast', 'Last to first' ) ], [ 'center', L( 'animOrderCenter', 'From the centre out' ) ], [ 'random', L( 'animOrderRandom', 'Random' ) ] ].map( function ( o ) { return '<option value="' + o[ 0 ] + '"' + ( o[ 0 ] === ord ? ' selected' : '' ) + '>' + esc( o[ 1 ] ) + '</option>'; } ).join( '' ) + '</select>' );
			}
			h += '<div class="fw-le-anim-keys">' + tr.frames.map( function ( f, i ) { return '<button type="button" data-act="kf" data-target="' + esc( tr.target ) + '" data-i="' + i + '">◆ ' + f.t.toFixed( 2 ) + ' s</button>'; } ).join( '' ) + '</div>';
			if ( tl.trigger.type !== 'load' && tl.trigger.target !== String( app.selectedId ) ) {
				h += '<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-wide" data-act="starts">' + esc( L( 'animStarts', 'Starts the timeline' ) ) + '</button>';
			}
			h += '<div class="fw-le-anim-presets">' + this.row( L( 'animUsePreset', 'Replace its moves with' ), this.startSelect().replace( / selected/g, '' ).replace( '<select data-start>', '<select data-replace data-target="' + esc( tr.target ) + '"><option value="" selected>' + esc( L( 'animChoose', 'Choose…' ) ) + '</option>' ) ) +
				'<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-wide" data-act="save-preset" data-target="' + esc( tr.target ) + '">' + esc( L( 'animSavePreset', 'Save these moves as a preset' ) ) + '</button></div>';
			h += this.otherTimelines( tl, tr.target );
			h += '<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-danger" data-act="remove-track" data-target="' + esc( tr.target ) + '">' + esc( L( 'animRemoveTrack', 'Remove from this timeline' ) ) + '</button>';
			return h;
		},
		panelKeyframe: function ( tl, tr, i ) {
			var f = tr.frames[ i ], h = this.head( L( 'animKeyframe', 'Keyframe' ) + ' · ' + this.trackName( tr ), true );
			h += this.row( L( 'animTime', 'Time (s)' ), '<input type="number" data-kf="t" min="0" max="' + tl.duration + '" step="0.05" value="' + f.t + '">' );
			PROPS.forEach( function ( p ) {
				h += '<label class="fw-le-anim-prop' + ( num( f[ p.k ] ) ? ' is-keyed' : '' ) + '"><span>' + esc( p.label ) + '</span><input type="number" data-kf="' + p.k + '" step="' + p.step + '" placeholder="—" value="' + ( num( f[ p.k ] ) ? f[ p.k ] : '' ) + '"><i>' + esc( p.unit ) + '</i></label>';
			} );
			h += '<p class="fw-le-anim-note">' + esc( L( 'animKfHint', 'Empty = this keyframe does not set it.' ) ) + '</p>';
			var cur = f.ease ? ekey( f.ease ) : '', groups = {}, order = [];
			CURVES.forEach( function ( c ) { if ( ! groups[ c.group ] ) { groups[ c.group ] = []; order.push( c.group ); } groups[ c.group ].push( c ); } );
			var opts = '<option value=""' + ( cur ? '' : ' selected' ) + '>' + esc( tr.ease ? L( 'animTrackCurve', 'The track’s curve' ) + ' (' + curveLabel( tr.ease ) + ')' : L( 'animLinear', 'Linear' ) ) + '</option>';
			order.forEach( function ( g ) { opts += '<optgroup label="' + esc( g || L( 'animCurves', 'Curves' ) ) + '">' + groups[ g ].map( function ( c ) { return '<option value="' + esc( c.key ) + '"' + ( c.key === cur ? ' selected' : '' ) + '>' + esc( c.label ) + '</option>'; } ).join( '' ) + '</optgroup>'; } );
			if ( cur && ! CURVES.some( function ( c ) { return c.key === cur; } ) ) { opts += '<option value="' + esc( cur ) + '" selected>' + esc( curveLabel( cur ) ) + '</option>'; }
			h += this.row( L( 'animCurve', 'Curve into it' ), '<select data-kf="ease">' + opts + '</select>', i === 0 ? L( 'animFirstKf', 'The first keyframe has nothing before it, so its curve is not used.' ) : '' );
			h += '<canvas class="fw-le-anim-curve" width="240" height="120" data-css="' + esc( f.ease ? ecss( f.ease ) : ( tr.ease ? ecss( tr.ease ) : 'linear' ) ) + '"></canvas>';
			h += '<button type="button" class="fw-le-btn fw-le-btn--ghost fw-le-anim-danger" data-act="delete-kf">' + esc( L( 'animDeleteKf', 'Delete this keyframe' ) ) + '</button>';
			setTimeout( function () { A.drawCurve(); }, 0 );
			return h;
		},
		drawCurve: function () {
			var c = $( '#fw-le-anim-panel .fw-le-anim-curve' )[ 0 ];
			if ( ! c ) { return; }
			var x = c.getContext( '2d' ), w = c.width, hh = c.height, pad = 14, fn = easeFn( c.getAttribute( 'data-css' ) ) || function ( t ) { return t; };
			x.clearRect( 0, 0, w, hh );
			x.strokeStyle = '#3c3f4a'; x.lineWidth = 1;
			x.beginPath(); x.moveTo( pad, hh - pad - ( hh - 2 * pad ) * 0.2 ); x.lineTo( w - pad, hh - pad - ( hh - 2 * pad ) * 0.2 ); x.moveTo( pad, pad + ( hh - 2 * pad ) * 0 ); x.stroke();
			var y0 = hh - pad - ( hh - 2 * pad ) * 0.2, y1 = pad + ( hh - 2 * pad ) * 0.1, span = y0 - y1;
			x.strokeStyle = '#555a66'; x.setLineDash( [ 3, 3 ] ); x.beginPath(); x.moveTo( pad, y1 ); x.lineTo( w - pad, y1 ); x.stroke(); x.setLineDash( [] );
			x.strokeStyle = '#2ad38b'; x.lineWidth = 2; x.beginPath();
			for ( var i = 0; i <= 60; i++ ) { var t = i / 60, px = pad + ( w - 2 * pad ) * t, py = y0 - span * fn( t ); if ( i ) { x.lineTo( px, py ); } else { x.moveTo( px, py ); } }
			x.stroke();
		},
		bindPanel: function ( $p ) {
			var self = this;
			$p.on( 'change', '[data-tl]', function () {
				var key = this.getAttribute( 'data-tl' ), el = this, tl = self.active();
				self.commit( function () {
					if ( key === 'name' ) { tl.name = String( el.value ).slice( 0, 80 ) || tl.name; }
					else if ( key === 'duration' ) { tl.duration = Math.max( 0.2, Math.min( 120, Number( el.value ) || 2 ) ); }
					else if ( key === 'repeat' ) { if ( el.checked ) { tl.repeat = -1; } else { delete tl.repeat; delete tl.yoyo; } }
					else if ( key === 'yoyo' ) { if ( el.checked ) { tl.yoyo = true; } else { delete tl.yoyo; } }
					else if ( key === 'trigger.type' ) { tl.trigger = { type: el.value }; }
					else if ( key === 'trigger.target' ) { if ( el.value ) { tl.trigger.target = el.value; } else { delete tl.trigger.target; } }
					else if ( key === 'trigger.leave' ) { if ( el.checked ) { delete tl.trigger.leave; } else { tl.trigger.leave = 'stay'; } }
					else if ( key === 'trigger.toggle' ) { if ( el.checked ) { tl.trigger.toggle = true; } else { delete tl.trigger.toggle; } }
					else if ( key === 'trigger.once' ) { if ( el.checked ) { tl.trigger.once = false; } else { delete tl.trigger.once; } }
					else if ( key === 'trigger.pin' ) { if ( el.checked ) { tl.trigger.pin = true; tl.trigger.length = tl.trigger.length || 2; } else { delete tl.trigger.pin; delete tl.trigger.length; } }
					else if ( key === 'trigger.length' ) { tl.trigger.length = Math.max( 0.5, Math.min( 10, Number( el.value ) || 2 ) ); }
				} );
			} );
			$p.on( 'change', '[data-start]', function () { self.start = this.value; } );
			$p.on( 'change', '[data-site]', function () { var tl = self.active(), on = this.checked; self.commit( function () { if ( on ) { tl.site = true; } else { delete tl.site; } } ); } );
			$p.on( 'change', '[data-replace]', function () {
				var tr = self.track( this.getAttribute( 'data-target' ) ), st = this.value ? self.startOf( this.value ) : null, tl = self.active();
				if ( ! tr || ! st ) { return; }
				self.commit( function () {
					tr.frames = st.frames;
					if ( self.isClass( tr.target ) && st.stagger ) { tr.stagger = st.stagger; }
					var end = st.frames[ st.frames.length - 1 ].t;
					if ( tl.duration < end ) { tl.duration = Math.ceil( end * 10 ) / 10; }
					self.fitDuration( tl, tr ); self.kf = null;
				} );
			} );
			$p.on( 'change', '[data-dev]', function () {
				var tl = self.active(), on = $p.find( '[data-dev]:checked' ).map( function () { return this.getAttribute( 'data-dev' ); } ).get();
				self.commit( function () { if ( on.length === 3 ) { delete tl.runsOn; } else { tl.runsOn = on; } } );
			} );
			$p.on( 'change', '[data-cl]', function () {
				var k = this.getAttribute( 'data-cl' ), el = this, tr = self.trackFor( String( app.selectedId ) ), tl = self.active();
				if ( ! tr ) { return; }
				self.commit( function () {
					if ( k === 'stagger' ) { tr.stagger = Math.max( 0, Math.min( 5, Number( el.value ) || 0 ) ); if ( ! tr.stagger ) { delete tr.stagger; } }
					else if ( el.value === 'first' ) { delete tr.order; } else { tr.order = el.value; }
					self.fitDuration( tl, tr );
				} );
			} );
			$p.on( 'change', '[data-prop]', function () {
				var k = this.getAttribute( 'data-prop' ), v = Number( this.value ), tr = self.trackFor( String( app.selectedId ) );
				if ( ! tr || ! isFinite( v ) ) { return; }
				self.commit( function () { self.setAt( tr, k, v ); } );
			} );
			$p.on( 'change', '[data-kf]', function () {
				var k = this.getAttribute( 'data-kf' ), el = this, tr = self.track( self.kf.target ), f = tr && tr.frames[ self.kf.i ], tl = self.active();
				if ( ! f ) { return; }
				self.commit( function () {
					if ( k === 't' ) {
						f.t = r3( Math.max( 0, Math.min( tl.duration, Number( el.value ) || 0 ) ) );
						tr.frames.sort( function ( a, b ) { return a.t - b.t; } );
						self.kf.i = tr.frames.indexOf( f );
						self.t = f.t;
					} else if ( k === 'ease' ) {
						if ( el.value ) { f.ease = el.value; } else { delete f.ease; delete f.e; }
					} else if ( el.value === '' ) { delete f[ k ]; }
					else { f[ k ] = Number( el.value ); }
				} );
			} );
			$p.on( 'click', '[data-act]', function () {
				var act = this.getAttribute( 'data-act' ), tl = self.active(), id = String( app.selectedId || '' ), btn = this;
				if ( act === 'settings' ) { self.kf = null; self.settings = true; self.renderPanel(); self.renderDock(); }
				else if ( act === 'add' ) { self.addTrack( id ); }
				else if ( act === 'add-class' ) { self.addTrack( '.' + btn.getAttribute( 'data-cls' ) ); }
				else if ( act === 'add-kf' ) { self.addKeyAt( self.track( btn.getAttribute( 'data-target' ) ), self.t ); }
				else if ( act === 'save-preset' ) {
					var ptr = self.track( btn.getAttribute( 'data-target' ) );
					var pname = ptr && window.prompt( L( 'animPresetName', 'A name for this preset' ), '' );
					if ( ! pname || ! String( pname ).trim() ) { return; }
					var preset = { id: 'pr-' + Math.random().toString( 36 ).slice( 2, 8 ), name: String( pname ).trim().slice( 0, 60 ), frames: ptr.frames.map( function ( f ) { var c = $.extend( {}, f ); delete c.e; return c; } ) };
					if ( self.isClass( ptr.target ) && ptr.stagger ) { preset.stagger = ptr.stagger; if ( ptr.order ) { preset.order = ptr.order; } }
					self.savePresets( self.presets.concat( [ preset ] ), function () { self.start = preset.id; self.renderPanel(); } );
				}
				else if ( act === 'starts' ) { self.commit( function () { tl.trigger.target = id; } ); }
				else if ( act === 'remove-track' ) { var rt = btn.getAttribute( 'data-target' ); self.commit( function () { tl.tracks = tl.tracks.filter( function ( tr ) { return tr.target !== rt; } ); if ( tl.trigger.target === rt ) { delete tl.trigger.target; } } ); }
				else if ( act === 'kf' ) { var kt = btn.getAttribute( 'data-target' ); self.kf = { target: kt, i: Number( btn.getAttribute( 'data-i' ) ) }; self.seek( self.track( kt ).frames[ self.kf.i ].t ); self.render(); }
				else if ( act === 'delete-kf' ) { var tr = self.track( self.kf.target ), i = self.kf.i; self.kf = null; self.commit( function () { tr.frames.splice( i, 1 ); if ( ! tr.frames.length ) { tl.tracks.splice( tl.tracks.indexOf( tr ), 1 ); } } ); }
				else if ( act === 'retarget' ) {
					var from = btn.getAttribute( 'data-from' );
					if ( self.track( id ) ) { return; }
					self.commit( function () { tl.tracks.forEach( function ( tr ) { if ( tr.target === from ) { tr.target = id; delete tr.label; delete tr.stagger; delete tr.order; } } ); if ( tl.trigger.target === from ) { tl.trigger.target = id; } } );
				}
				else if ( act === 'delete-tl' ) {
					if ( ! window.confirm( L( 'animDeleteConfirm', 'Delete this timeline?' ) + ' “' + tl.name + '”' ) ) { return; }
					self.stop();
					self.commit( function () { self.list = self.list.filter( function ( t ) { return t.id !== tl.id; } ); if ( ! self.list.length ) { self.list.push( self.newTimeline() ); } self.activeId = self.list[ 0 ].id; self.kf = null; self.t = 0; } );
				}
				else if ( act === 'export-one' ) { download( slug( tl.name, 'timeline' ) + '.timeline.json', self.toJson( [ tl ] ), 'application/json' ); }
				else if ( act === 'export-all' ) { download( slug( cfg.pageTitle, 'page' ) + '-timelines.json', self.toJson( self.list.filter( function ( t ) { return t.tracks.length; } ), true ), 'application/json' ); }
				else if ( act === 'export-csv' ) { download( slug( cfg.pageTitle, 'page' ) + '-timelines.csv', toCsv( self.forSave() ), 'text/csv' ); }
				else if ( act === 'import' ) { $p.find( 'input[type=file]' ).trigger( 'click' ); }
			} );
			$p.on( 'toggle', '.fw-le-anim-io', function () { self.ioOpen = this.open; } );
			$p[ 0 ].addEventListener( 'toggle', function ( e ) { if ( e.target.classList && e.target.classList.contains( 'fw-le-anim-io' ) ) { self.ioOpen = e.target.open; } }, true );
			$p.on( 'change', 'input[type=file]', function () {
				var file = this.files && this.files[ 0 ], input = this;
				if ( ! file ) { return; }
				file.text().then( function ( text ) {
					try {
						self.pendingPresets = null;
						var got = self.parseFile( file.name, text );
						if ( got.length ) { self.importList( got ); }
						if ( self.pendingPresets ) {
							var have = {}, add = [];
							self.presets.forEach( function ( p ) { have[ p.id ] = 1; } );
							self.pendingPresets.forEach( function ( p ) { if ( p && p.id && ! have[ p.id ] ) { add.push( p ); } } );
							var n = add.length;
							self.savePresets( self.presets.concat( add ), function () { self.ioNote = ( got.length ? self.ioNote + ' ' : '' ) + L( 'animPresetsIn', 'Presets added: ' ) + n + '.'; self.renderPanel(); } );
						}
					}
					catch ( e ) { self.ioNote = e.message || String( e ); self.renderPanel(); }
					input.value = '';
				} );
			} );
		},
		/** Add a keyframe to a track at time t, holding the values it has there (so the motion is unchanged), and open it. */
		addKeyAt: function ( tr, t ) {
			var tl = this.active(), self = this;
			if ( ! tr || ! tl ) { return; }
			t = r3( Math.max( 0, Math.min( tl.duration, t ) ) );
			var at = tr.frames.filter( function ( f ) { return Math.abs( f.t - t ) < NEAR; } )[ 0 ];
			if ( at ) { this.kf = { target: tr.target, i: tr.frames.indexOf( at ) }; this.t = at.t; this.push(); this.render(); return; }
			this.commit( function () {
				var f = { t: t, ease: DEF_EASE };
				PROPS.forEach( function ( p ) { var v = valueAt( tr.frames, p.k, t ); if ( v !== undefined ) { f[ p.k ] = r3( v ); } } );
				if ( Object.keys( f ).length === 2 ) { f.opacity = 1; } // a track keyed nothing yet: start with Opacity
				tr.frames.push( f );
				tr.frames.sort( function ( a, b ) { return a.t - b.t; } );
				self.kf = { target: tr.target, i: tr.frames.indexOf( f ) };
				self.t = t;
			} );
		},
		/** The track to add a keyframe to: the selected keyframe's, else the selected element's. */
		keyTrack: function () {
			if ( this.kf ) { return this.track( this.kf.target ); }
			return app.selectedId ? this.trackFor( String( app.selectedId ) ) : null;
		},

		/** Set a property at the playhead: on a keyframe there, or a new one. A property keyed for the first time
		 *  later than 0 also gets its resting value at 0, so it moves from rest instead of jumping. */
		setAt: function ( tr, k, v ) {
			var t = r3( this.t ), p = PROPS.filter( function ( x ) { return x.k === k; } )[ 0 ];
			if ( p.min != null ) { v = Math.max( p.min, v ); } if ( p.max != null ) { v = Math.min( p.max, v ); }
			var wasKeyed = tr.frames.some( function ( f ) { return num( f[ k ] ); } );
			var at = function ( time, ease ) {
				var f = tr.frames.filter( function ( x ) { return Math.abs( x.t - time ) < NEAR; } )[ 0 ];
				if ( ! f ) { f = { t: time }; if ( ease ) { f.ease = ease; } tr.frames.push( f ); tr.frames.sort( function ( a, b ) { return a.t - b.t; } ); }
				return f;
			};
			if ( ! wasKeyed && t > NEAR ) { at( 0 )[ k ] = p.rest; }
			at( t, DEF_EASE )[ k ] = r3( v );
		},
		/** A starting point or one of the site's presets, by id: { name, frames, stagger?, order? } (frames copied). */
		startOf: function ( id ) {
			var p = STARTS.concat( this.presets ).filter( function ( x ) { return x.id === id; } )[ 0 ] || STARTS[ 0 ];
			var frames = p.frames.map( function ( f ) { var c = $.extend( {}, f ); delete c.e; if ( c.ease && ! EASE_CSS[ ekey( c.ease ) ] ) { c.ease = DEF_EASE; } return c; } );
			return { name: p.name, frames: frames, stagger: p.stagger, order: p.order };
		},
		startSelect: function () {
			var self = this, opt = function ( p ) { return '<option value="' + esc( p.id ) + '"' + ( p.id === self.start ? ' selected' : '' ) + '>' + esc( p.name ) + '</option>'; };
			return '<select data-start>' + '<optgroup label="' + esc( L( 'animStarts', 'Starting points' ) ) + '">' + STARTS.map( opt ).join( '' ) + '</optgroup>' +
				( this.presets.length ? '<optgroup label="' + esc( L( 'animYourPresets', 'Your presets' ) ) + '">' + this.presets.map( opt ).join( '' ) + '</optgroup>' : '' ) + '</select>';
		},
		addTrack: function ( id ) {
			var tl = this.active(), self = this;
			if ( ! id || this.track( id ) ) { return; }
			var cls = this.isClass( id ), node = cls ? null : app.nodeOf( id ), st = this.startOf( this.start );
			this.settings = false;
			this.commit( function () {
				var tr = { target: id, label: cls ? id : ( node && app.labelFor ? app.labelFor( node ) : 'Element' ), frames: st.frames };
				if ( cls ) { tr.stagger = st.stagger || 0.1; if ( st.order ) { tr.order = st.order; } }
				var end = st.frames[ st.frames.length - 1 ].t;
				if ( tl.duration < end ) { tl.duration = Math.ceil( end * 10 ) / 10; }
				tl.tracks.push( tr );
				if ( tl.duration < 0.6 ) { tl.duration = 1; }
				self.fitDuration( tl, tr );
				self.t = 0;
			} );
		},
		/** A class track's last element must finish inside the timeline: lengthen it when the stagger asks for more. */
		fitDuration: function ( tl, tr ) {
			if ( ! this.isClass( tr.target ) || ! tr.frames.length ) { return; }
			var n = Math.max( 1, this.matches( tr.target ).length ), need = tr.frames[ tr.frames.length - 1 ].t + ( n - 1 ) * ( tr.stagger || 0 );
			if ( need > tl.duration ) { tl.duration = Math.min( 120, Math.ceil( need * 10 ) / 10 ); }
		},
		toJson: function ( list, withPresets ) {
			var tmp = this.list; this.list = list; var out = this.forSave(); this.list = tmp;
			var doc = { format: 'unysonplus-page-timelines', version: 1, page: cfg.pageUrl || '', timelines: out };
			if ( withPresets && this.presets.length ) { doc.presets = this.presets; }
			return JSON.stringify( doc, null, 2 );
		},
		/** The site's preset library (5g): stored at once, for every page. */
		savePresets: function ( list, done ) {
			var self = this;
			$.post( cfg.ajaxUrl, { action: 'fw_live_editor_timeline_presets', post_id: cfg.postId, nonce: cfg.nonce, presets: JSON.stringify( list ) } )
				.done( function ( r ) {
					if ( r && r.success ) { self.presets = r.data.presets || []; if ( done ) { done(); } }
					else { window.alert( ( r && r.data && r.data.message ) || 'The preset was not saved.' ); }
				} );
		},
		parseFile: function ( name, text ) {
			var t = String( text ).trim(), raw = [];
			if ( /\.csv$/i.test( name ) || ( t[ 0 ] !== '{' && t[ 0 ] !== '[' ) ) { raw = fromCsv( text ); }
			else {
				var d; try { d = JSON.parse( t ); } catch ( e ) { throw new Error( L( 'animBadJson', 'This file is not valid JSON.' ) ); }
				raw = Array.isArray( d ) ? d : ( d && Array.isArray( d.timelines ) ? d.timelines : ( d && d.tracks ? [ d ] : [] ) );
				if ( d && Array.isArray( d.presets ) && d.presets.length ) { this.pendingPresets = d.presets; }
			}
			raw = raw.filter( function ( x ) { return x && typeof x === 'object' && x.id; } ).slice( 0, 50 );
			if ( ! raw.length && this.pendingPresets ) { return []; }
			if ( ! raw.length ) { throw new Error( L( 'animNoTimelines', 'No page timelines found in this file.' ) ); }
			return raw.map( this.clean );
		},
		importList: function ( got ) {
			var self = this, taken = {}, away = 0;
			this.list.forEach( function ( t ) { taken[ t.id ] = 1; } );
			got.forEach( function ( t ) {
				if ( taken[ t.id ] ) { t.id = 'tl-' + Math.random().toString( 36 ).slice( 2, 8 ); }
				t.tracks.forEach( function ( tr ) { if ( ! app.nodeOf( tr.target ) ) { away++; } } );
			} );
			this.commit( function () {
				self.list = self.list.filter( function ( t ) { return t.tracks.length || t.id !== self.activeId; } ).concat( got );
				self.activeId = got[ 0 ].id; self.kf = null; self.t = 0;
			} );
			this.ioNote = L( 'animImported', 'Imported: ' ) + got.length + '.' + ( away ? ' ' + away + ' ' + L( 'animAwayN', 'track(s) point at elements not on this page. Select an element to give it one of them.' ) : '' ) + ' ' + L( 'animSaveToKeep', 'Save to keep them.' );
			this.renderPanel();
		},

		/* -- the timeline dock -- */
		renderDock: function () {
			var $d = $( '#fw-le-anim-dock' ), tl = this.active(), self = this;
			if ( ! $d.length || ! tl ) { return; }
			var sel = String( app.selectedId || '' ), span = tl.duration;
			var stepT = span <= 2 ? 0.25 : span <= 5 ? 0.5 : span <= 12 ? 1 : 5, ticks = '';
			for ( var s = 0; s <= span + 1e-6; s += stepT ) { ticks += '<i style="left:' + ( s / span * 100 ) + '%" data-t="' + ( Math.round( s * 100 ) / 100 ) + 's"></i>'; }
			var rows = tl.tracks.map( function ( tr ) {
				var first = tr.frames[ 0 ], last = tr.frames[ tr.frames.length - 1 ];
				var bar = first ? '<span class="fw-le-anim-dock__bar" style="left:' + ( first.t / span * 100 ) + '%;width:' + ( Math.max( 0, last.t - first.t ) / span * 100 ) + '%"></span>' : '';
				var dia = tr.frames.map( function ( f, i ) {
					var on = self.kf && self.kf.target === tr.target && self.kf.i === i;
					return '<b class="fw-le-anim-dock__kf' + ( on ? ' is-on' : '' ) + '" data-i="' + i + '" style="left:' + ( f.t / span * 100 ) + '%" title="' + f.t.toFixed( 2 ) + ' s"></b>';
				} ).join( '' );
				var mine = self.trackFor( sel ), n = self.isClass( tr.target ) ? self.matches( tr.target ).length : 1;
				if ( n > 1 && tr.stagger && first ) {
					for ( var g = 1; g < n; g++ ) { bar += '<span class="fw-le-anim-dock__ghost" style="left:' + ( ( first.t + g * tr.stagger ) / span * 100 ) + '%;width:' + ( Math.max( 0, last.t - first.t ) / span * 100 ) + '%"></span>'; }
				}
				return '<div class="fw-le-anim-dock__row' + ( mine && mine.target === tr.target ? ' is-sel' : '' ) + ( self.present( tr ) ? '' : ' is-away' ) + '" data-target="' + esc( tr.target ) + '">' +
					'<span class="fw-le-anim-dock__lbl" title="' + esc( self.trackName( tr ) ) + '">' + esc( self.trackName( tr ) ) + '</span>' +
					'<div class="fw-le-anim-dock__lane">' + bar + dia + '</div></div>';
			} ).join( '' );
			if ( ! rows ) { rows = '<p class="fw-le-anim-dock__empty">' + esc( L( 'animDockEmpty', 'No tracks yet. Select an element on the page, then “Animate this element” in the panel on the right.' ) ) + '</p>'; }
			$d.html(
				'<header class="fw-le-anim-dock__head"><strong>' + esc( tl.name ) + '</strong>' +
				'<span class="fw-le-anim-dock__trig">' + esc( ( TRIGGERS.filter( function ( x ) { return x.v === tl.trigger.type; } )[ 0 ] || TRIGGERS[ 0 ] ).label ) + '</span>' +
				'<span class="fw-le-anim-dock__tools"><button type="button" data-addkf title="' + esc( L( 'animAddKfTip', 'Add a keyframe at the playhead, on the selected element’s track (K)' ) ) + '">◆+</button><button type="button" data-z="-1" title="' + esc( L( 'animZoomOut', 'Zoom out' ) ) + '">−</button><button type="button" data-z="1" title="' + esc( L( 'animZoomIn', 'Zoom in' ) ) + '">+</button>' +
				'<button type="button" data-collapse title="' + esc( L( 'animCollapse', 'Show or hide the timeline' ) ) + '"><span class="dashicons dashicons-arrow-down-alt2"></span></button></span></header>' +
				'<div class="fw-le-anim-dock__scroll"><div class="fw-le-anim-dock__inner" style="--z:' + this.zoom + '">' +
				'<div class="fw-le-anim-dock__row fw-le-anim-dock__axis"><span class="fw-le-anim-dock__lbl"></span><div class="fw-le-anim-dock__lane fw-le-anim-dock__ruler">' + ticks + '</div></div>' +
				rows + '<span class="fw-le-anim-dock__playhead"></span></div></div>'
			);
			this.drawPlayhead();
		},
		drawPlayhead: function () {
			var tl = this.active(), $lane = $( '#fw-le-anim-dock .fw-le-anim-dock__ruler' ), $ph = $( '#fw-le-anim-dock .fw-le-anim-dock__playhead' );
			if ( tl && $lane.length && $ph.length ) {
				var inner = $lane.closest( '.fw-le-anim-dock__inner' )[ 0 ].getBoundingClientRect(), lane = $lane[ 0 ].getBoundingClientRect();
				$ph.css( 'left', ( lane.left - inner.left + lane.width * ( this.t / tl.duration ) ) + 'px' );
			}
			$( '#fw-le-anim-bar .fw-le-anim-bar__time' ).text( this.t.toFixed( 2 ) + ' / ' + ( tl ? tl.duration.toFixed( 2 ) : '0' ) + ' s' );
		},
		timeAt: function ( lane, clientX ) {
			var r = lane.getBoundingClientRect(), tl = this.active();
			return Math.max( 0, Math.min( 1, ( clientX - r.left ) / r.width ) ) * tl.duration;
		},
		bindDock: function ( $d ) {
			var self = this;
			$d.on( 'click', '[data-z]', function () { self.zoom = Math.max( 1, Math.min( 8, self.zoom * ( this.getAttribute( 'data-z' ) === '1' ? 1.5 : 1 / 1.5 ) ) ); self.renderDock(); } );
			$d.on( 'click', '[data-collapse]', function () { $( 'body' ).toggleClass( 'fw-le-anim-dock-min' ); } );
			$d.on( 'click', '[data-addkf]', function () {
				var tr = self.keyTrack();
				if ( tr ) { self.addKeyAt( tr, self.t ); } else { window.alert( L( 'animPickTrack', 'Select an element that is in this timeline first (on the page, or a name on the timeline).' ) ); }
			} );
			$d.on( 'dblclick', '.fw-le-anim-dock__row:not(.fw-le-anim-dock__axis) .fw-le-anim-dock__lane', function ( e ) {
				if ( $( e.target ).is( '.fw-le-anim-dock__kf' ) ) { return; }
				var target = $( this ).closest( '[data-target]' ).attr( 'data-target' );
				self.addKeyAt( self.track( target ), self.timeAt( this, e.clientX ) );
			} );
			$d.on( 'click', '.fw-le-anim-dock__lbl', function () {
				var id = $( this ).closest( '[data-target]' ).attr( 'data-target' );
				self.kf = null; self.settings = false;
				self.select( self.isClass( id ) ? self.firstIdOf( id ) : id );
			} );
			// The ruler (and any empty spot on a lane): click or drag to move the playhead.
			$d.on( 'pointerdown', '.fw-le-anim-dock__ruler, .fw-le-anim-dock__lane', function ( e ) {
				if ( $( e.target ).is( '.fw-le-anim-dock__kf' ) ) { return; }
				var lane = this;
				e.preventDefault();
				self.seek( self.timeAt( lane, e.clientX ) );
				var move = function ( ev ) { self.seek( self.timeAt( lane, ev.clientX ) ); };
				var up = function () { document.removeEventListener( 'pointermove', move ); document.removeEventListener( 'pointerup', up ); };
				document.addEventListener( 'pointermove', move ); document.addEventListener( 'pointerup', up );
			} );
			// A keyframe: click to select it (and its element); drag to change its time (snapped to 0.05 s, Shift: free).
			$d.on( 'pointerdown', '.fw-le-anim-dock__kf', function ( e ) {
				e.preventDefault(); e.stopPropagation();
				var $row = $( this ).closest( '[data-target]' ), target = $row.attr( 'data-target' ), i = Number( this.getAttribute( 'data-i' ) );
				// Measure the lane now: the dock is redrawn on every move, so the element itself is replaced (and a
				// detached one measures 0 wide, which sent every dragged keyframe to the end).
				var tr = self.track( target ), f = tr.frames[ i ], rect = $row.find( '.fw-le-anim-dock__lane' )[ 0 ].getBoundingClientRect(), x0 = e.clientX, moved = false;
				self.dragging = true;
				self.kf = { target: target, i: i }; self.settings = false;
				var selT = self.trackFor( String( app.selectedId ) );
				if ( ! selT || selT.target !== target ) { self.select( self.isClass( target ) ? self.firstIdOf( target ) : target ); }
				var move = function ( ev ) {
					if ( ! moved && Math.abs( ev.clientX - x0 ) < 3 ) { return; }
					if ( ! moved ) { moved = true; app.undoStack.push( self.snap() ); app.redoStack.length = 0; }
					var t = Math.max( 0, Math.min( 1, ( ev.clientX - rect.left ) / ( rect.width || 1 ) ) ) * self.active().duration;
					if ( ! ev.shiftKey ) { t = Math.round( t / SNAP ) * SNAP; }
					f.t = r3( t );
					tr.frames.sort( function ( a, b ) { return a.t - b.t; } );
					self.kf.i = tr.frames.indexOf( f );
					self.t = f.t;
					self.renderDock(); self.push();
				};
				var up = function () {
					document.removeEventListener( 'pointermove', move ); document.removeEventListener( 'pointerup', up );
					self.dragging = false;
					if ( moved ) { self.changed(); } else { self.seek( f.t ); self.render(); }
				};
				document.addEventListener( 'pointermove', move ); document.addEventListener( 'pointerup', up );
			} );
		},
	};

	/* ---- hooks into the editor ---- */
	A.list = ( Array.isArray( cfg.pageTimelines ) ? cfg.pageTimelines : [] ).map( A.clean )
		.concat( ( Array.isArray( cfg.siteTimelines ) ? cfg.siteTimelines : [] ).map( function ( t ) { t = A.clean( t ); t.site = true; return t; } ) );
	A.presets = Array.isArray( cfg.timelinePresets ) ? cfg.timelinePresets : [];
	if ( A.list.length ) { A.activeId = A.list[ 0 ].id; }

	// Undo / redo: timeline changes sit on the editor's own stacks, marked { __tl }.
	var origUndo = app.undo, origRedo = app.redo;
	app.undo = function () {
		var top = this.undoStack[ this.undoStack.length - 1 ];
		if ( top && top.__tl ) { this.undoStack.pop(); this.redoStack.push( A.snap() ); A.restore( top ); return; }
		return origUndo.apply( this, arguments );
	};
	app.redo = function () {
		var top = this.redoStack[ this.redoStack.length - 1 ];
		if ( top && top.__tl ) { this.redoStack.pop(); this.undoStack.push( A.snap() ); A.restore( top ); return; }
		return origRedo.apply( this, arguments );
	};
	// One Save: the timelines go with the page when they changed.
	app.saveExtras = ( app.saveExtras || [] ).concat( function () {
		if ( ! A.tlDirty ) { return {}; }
		var out = { timelines: JSON.stringify( A.forSave( false ) ) };
		if ( cfg.canSite ) { out.site_timelines = JSON.stringify( A.forSave( true ) ); }
		return out;
	} );
	app.afterSaveHooks = ( app.afterSaveHooks || [] ).concat( function () { A.tlDirty = false; } );
	// Selection: the panel follows it.
	var origSelect = app.onSelect;
	app.onSelect = function () {
		var r = origSelect.apply( this, arguments );
		if ( A.on ) {
			var sid = String( this.selectedId || '' );
			if ( sid && ! A.trackFor( sid ) ) {
				var other = A.list.filter( function ( t ) { return A.trackIn( t, sid ); } )[ 0 ];
				if ( other ) { A.switchTo( other.id ); }
			}
			var ft = A.trackFor( sid );
			if ( A.kf && ( ! ft || ft.target !== A.kf.target ) ) { A.kf = null; }
			if ( this.selectedId ) { A.settings = false; }
			A.renderPanel(); A.renderDock();
		}
		return r;
	};
	// K and Space pressed while the canvas has focus come through the editor's shortcut forwarding.
	var origShortcut = app.handleForwardedShortcut;
	app.handleForwardedShortcut = function ( p ) {
		if ( A.on && p && p.key === 'anim-key' ) { var tr = A.keyTrack(); if ( tr ) { A.addKeyAt( tr, A.t ); } return; }
		if ( A.on && p && p.key === 'anim-play' ) { A.play(); return; }
		return origShortcut.apply( this, arguments );
	};
	// A reloaded canvas (after Preview, a device switch…) gets the workspace back.
	var origReady = app.onFrameReady;
	app.onFrameReady = function () { var r = origReady.apply( this, arguments ); if ( A.on ) { A.toFrame(); } return r; };
	// Leaving for Preview leaves Animate.
	var origMode = app.setMode;
	app.setMode = function ( mode ) {
		if ( mode === 'preview' && A.on ) { A.leave(); }
		if ( mode !== 'preview' ) { this.scrollTools = false; }
		return origMode.apply( this, arguments );
	};
	// Keys: Space plays, Delete removes the selected keyframe; in Animate, Delete never deletes an element.
	document.addEventListener( 'keydown', function ( e ) {
		if ( ! A.on ) { return; }
		var t = e.target, tag = t && t.tagName;
		if ( tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ( t && t.isContentEditable ) || e.ctrlKey || e.metaKey ) { return; }
		if ( e.key === ' ' ) { e.preventDefault(); e.stopImmediatePropagation(); A.play(); }
		else if ( ( e.key === 'k' || e.key === 'K' ) && ! e.altKey ) { var ktr = A.keyTrack(); if ( ktr ) { e.preventDefault(); A.addKeyAt( ktr, A.t ); } }
		else if ( e.key === 'Delete' || e.key === 'Backspace' ) {
			e.preventDefault(); e.stopImmediatePropagation();
			if ( A.kf ) { $( '#fw-le-anim-panel [data-act="delete-kf"]' ).trigger( 'click' ); }
		}
	}, true );

	$( function () { A.switcher(); } );
	app.anim = A;
} )( window.jQuery );
