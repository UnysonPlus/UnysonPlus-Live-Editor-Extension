/**
 * Live Editor — working together (roadmap 7i).
 *
 *  - Comments pinned to an element: a Comments panel (threads, replies, resolve, delete) and numbered pins on the
 *    canvas. Right-click → Comment… starts a thread on that element.
 *  - Presence: the others who have this page open, as avatars in the toolbar, and the element each one has
 *    selected outlined in their colour on the canvas. A notice when someone else saves the page.
 *  - Staging copy: make a draft copy to change and review, share a review link, publish it onto the live page or
 *    discard it.
 *
 * Server side: includes/class-fw-le-collab.php (AJAX action fw_le_collab). Extends window.fwLiveEditor.
 */
( function ( $ ) {
	'use strict';

	var app = window.fwLiveEditor;
	var cfg = window._fwLiveEditor || {};
	var C   = window._fwLeCollab || {};
	if ( ! app || ! $ || ! C.me ) { return; }

	function notify( msg, type ) {
		if ( window.fw && window.fw.notify ) { window.fw.notify( msg, type || 'info' ); } else { window.alert( msg ); }
	}
	function esc( s ) {
		return String( s == null ? '' : s ).replace( /[&<>"']/g, function ( c ) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ]; } );
	}
	function ago( t ) {
		var s = Math.max( 0, Math.round( Date.now() / 1000 - t ) );
		if ( s < 60 ) { return 'just now'; }
		if ( s < 3600 ) { return Math.round( s / 60 ) + ' min ago'; }
		if ( s < 86400 ) { return Math.round( s / 3600 ) + ' h ago'; }
		return new Date( t * 1000 ).toLocaleDateString();
	}
	function call( op, data ) {
		return $.post( cfg.ajaxUrl, $.extend( { action: 'fw_le_collab', op: op, post_id: cfg.postId, nonce: cfg.nonce }, data || {} ) ).then( function ( r ) {
			if ( r && r.success ) { return r.data; }
			return $.Deferred().reject( ( r && r.data && r.data.message ) || 'Something went wrong.' ).promise();
		}, function ( x ) {
			return $.Deferred().reject( ( x && x.responseJSON && x.responseJSON.data && x.responseJSON.data.message ) || 'The site did not answer.' ).promise();
		} );
	}
	/** A short name for an item: its own label, else its first words, else its type. */
	function itemLabel( id ) {
		var n = id && app.nodeOf( id );
		if ( ! n ) { return 'Page'; }
		var a = n.atts || {};
		if ( typeof a._le_label === 'string' && a._le_label.trim() ) { return a._le_label.trim(); }
		var keys = [ 'title', 'label', 'text', 'content', 'heading', 'subtitle' ];
		for ( var i = 0; i < keys.length; i++ ) {
			var v = a[ keys[ i ] ];
			if ( typeof v === 'string' ) {
				var t = v.replace( /<[^>]+>/g, ' ' ).replace( /\s+/g, ' ' ).trim();
				if ( t ) { return t.length > 40 ? t.slice( 0, 40 ) + '…' : t; }
			}
		}
		var type = n.type === 'simple' ? String( n.shortcode || 'element' ).replace( /_/g, ' ' ) : ( n.type === 'flexbox' && a.html_tag === 'section' ? 'section' : n.type );
		return type.charAt( 0 ).toUpperCase() + type.slice( 1 );
	}

	var S = { threads: [], others: [], stamp: null, open: false, resolved: false, target: null, focus: null, seenSave: ( C.saved && C.saved.t ) || 0, timer: 0 };

	/* ---- toolbar -------------------------------------------------------- */
	var $status = $( '#fw-le-status' );
	var $pres   = $( '<span class="fw-le-presence" aria-label="Also editing this page"></span>' ).insertBefore( $status );
	var $cBtn   = $( '<button type="button" id="fw-le-comments" class="fw-le-btn fw-le-btn--icon fw-le-btn--ghost" title="Comments"><span class="dashicons dashicons-admin-comments"></span><b class="fw-le-ccount" hidden></b></button>' ).insertBefore( $status );
	var $sBtn   = $( '<button type="button" id="fw-le-stage" class="fw-le-btn fw-le-btn--icon fw-le-btn--ghost" title="Staging copy"><span class="dashicons dashicons-admin-page"></span></button>' ).insertBefore( $status );
	$cBtn.on( 'click', function () { panel( ! S.open ); } );
	$sBtn.on( 'click', function ( e ) { e.stopPropagation(); stagingMenu(); } );

	/* ---- comments panel --------------------------------------------------- */
	var $p = $( '<aside class="fw-le-cpanel" role="complementary" aria-label="Comments" hidden>' +
		'<div class="fw-le-cpanel__head"><strong>Comments</strong><label class="fw-le-cpanel__res"><input type="checkbox"> Show resolved</label><button type="button" class="fw-le-cpanel__x" aria-label="Close">×</button></div>' +
		'<div class="fw-le-cpanel__new"><div class="fw-le-cpanel__on"></div><textarea rows="3" placeholder="Write a comment… (select an element first to pin it there)"></textarea><button type="button" class="button button-primary">Comment</button></div>' +
		'<div class="fw-le-cpanel__list"></div></aside>' ).appendTo( 'body' );
	$p.on( 'click', '.fw-le-cpanel__x', function () { panel( false ); } );
	$p.on( 'change', '.fw-le-cpanel__res input', function () { S.resolved = this.checked; render(); } );
	$p.on( 'click', '.fw-le-cpanel__new .button', function () { add( $p.find( '.fw-le-cpanel__new textarea' ), null ); } );
	$p.on( 'keydown', 'textarea', function ( e ) { if ( e.key === 'Enter' && ( e.ctrlKey || e.metaKey ) ) { $( this ).siblings( '.button' ).trigger( 'click' ); } } );
	$p.on( 'click', '.fw-le-cth__item', function () { var id = $( this ).attr( 'data-item' ); if ( id && app.index[ id ] ) { app.jumpToItem( id ); } else { notify( 'That element is no longer on the page.', 'warning' ); } } );
	$p.on( 'click', '.fw-le-cth__reply .button', function () { add( $( this ).siblings( 'textarea' ), $( this ).closest( '.fw-le-cth' ).attr( 'data-id' ) ); } );
	$p.on( 'click', '.fw-le-cth__resolve', function () {
		var $t = $( this ).closest( '.fw-le-cth' );
		call( 'comment_resolve', { id: $t.attr( 'data-id' ), resolved: $t.hasClass( 'is-resolved' ) ? '' : 1 } ).then( setThreads, function ( m ) { notify( m, 'error' ); } );
	} );
	$p.on( 'click', '.fw-le-cth__del', function () {
		var id = $( this ).attr( 'data-id' );
		app.confirm( { title: 'Delete this comment?', message: 'It is removed for everyone. This cannot be undone.', confirmText: 'Delete', danger: true }, function () {
			call( 'comment_delete', { id: id } ).then( setThreads, function ( m ) { notify( m, 'error' ); } );
		} );
	} );

	function panel( open, target ) {
		S.open = !! open;
		$p.prop( 'hidden', ! S.open );
		$( 'body' ).toggleClass( 'fw-le-cpanel-open', S.open );
		$cBtn.toggleClass( 'is-active', S.open );
		if ( S.open ) {
			if ( target !== undefined ) { S.target = target; }
			if ( S.target === null || S.target === undefined ) { S.target = app.selectedId || null; }
			$p.find( '.fw-le-cpanel__on' ).html( S.target ? 'On <b>' + esc( itemLabel( S.target ) ) + '</b>' : 'On the page' );
			load();
		}
	}

	function add( $ta, parent ) {
		var text = $.trim( $ta.val() );
		if ( ! text ) { $ta.trigger( 'focus' ); return; }
		var data = { text: text };
		if ( parent ) { data.parent = parent; } else { data.item = S.target || ''; data.label = S.target ? itemLabel( S.target ) : ''; }
		$ta.prop( 'disabled', true );
		call( 'comment_add', data ).then( function ( d ) { $ta.val( '' ); setThreads( d ); }, function ( m ) { notify( m, 'error' ); } ).always( function () { $ta.prop( 'disabled', false ); } );
	}

	function load() {
		return call( 'comments' ).then( setThreads, function () {} );
	}
	function setThreads( d ) {
		S.threads = ( d && d.threads ) || [];
		render();
		pins();
	}

	function render() {
		var open = S.threads.filter( function ( t ) { return ! t.resolved; } ).length;
		$cBtn.find( '.fw-le-ccount' ).text( open ).prop( 'hidden', ! open );
		if ( ! S.open ) { return; }
		var list = S.threads.filter( function ( t ) { return S.resolved || ! t.resolved; } );
		// Newest activity first, the focused element's threads on top.
		list.sort( function ( a, b ) {
			var fa = S.focus && a.item === S.focus ? 1 : 0, fb = S.focus && b.item === S.focus ? 1 : 0;
			var la = a.replies.length ? a.replies[ a.replies.length - 1 ].t : a.t, lb = b.replies.length ? b.replies[ b.replies.length - 1 ].t : b.t;
			return ( fb - fa ) || ( lb - la );
		} );
		var html = list.map( function ( t ) {
			var msg = function ( m, isRoot ) {
				return '<div class="fw-le-cmsg"><img src="' + esc( m.avatar ) + '" alt="" width="24" height="24"><div><div class="fw-le-cmsg__by"><b>' + esc( m.name ) + '</b> <span>' + esc( ago( m.t ) ) + '</span>' +
					( m.mine || C.moderate ? ' <button type="button" class="fw-le-cth__del" data-id="' + esc( m.id ) + '" title="Delete">Delete</button>' : '' ) +
					'</div><div class="fw-le-cmsg__text">' + esc( m.text ).replace( /\n/g, '<br>' ) + '</div></div></div>';
			};
			return '<div class="fw-le-cth' + ( t.resolved ? ' is-resolved' : '' ) + ( S.focus && t.item === S.focus ? ' is-focus' : '' ) + '" data-id="' + esc( t.id ) + '">' +
				'<div class="fw-le-cth__top">' + ( t.item ? '<button type="button" class="fw-le-cth__item" data-item="' + esc( t.item ) + '">' + esc( t.label || itemLabel( t.item ) ) + '</button>' : '<span class="fw-le-cth__item is-page">Page</span>' ) +
				'<button type="button" class="fw-le-cth__resolve">' + ( t.resolved ? 'Reopen' : 'Resolve' ) + '</button></div>' +
				msg( t, true ) + t.replies.map( function ( r ) { return msg( r, false ); } ).join( '' ) +
				'<div class="fw-le-cth__reply"><textarea rows="1" placeholder="Reply…"></textarea><button type="button" class="button">Reply</button></div></div>';
		} ).join( '' );
		// A re-render (a pulse brought someone's comment) must not throw away a reply being typed.
		var drafts = {}, focused = null, $list = $p.find( '.fw-le-cpanel__list' );
		$list.find( '.fw-le-cth' ).each( function () {
			var ta = $( this ).find( '.fw-le-cth__reply textarea' )[ 0 ];
			if ( ta && ta.value ) { drafts[ this.getAttribute( 'data-id' ) ] = ta.value; }
			if ( ta && ta === document.activeElement ) { focused = { id: this.getAttribute( 'data-id' ), s: ta.selectionStart, e: ta.selectionEnd }; }
		} );
		$list.html( html || '<p class="fw-le-cpanel__empty">No comments yet. Select an element, write one above, or right-click an element → Comment….</p>' );
		$.each( drafts, function ( id, v ) { $list.find( '.fw-le-cth[data-id="' + id + '"] .fw-le-cth__reply textarea' ).val( v ); } );
		if ( focused ) {
			var ta2 = $list.find( '.fw-le-cth[data-id="' + focused.id + '"] .fw-le-cth__reply textarea' )[ 0 ];
			if ( ta2 ) { ta2.focus(); try { ta2.setSelectionRange( focused.s, focused.e ); } catch ( err ) {} }
		}
	}

	/** Numbered pins on the canvas, one per element with open comments. */
	function pins() {
		var by = {};
		S.threads.forEach( function ( t ) {
			if ( t.resolved || ! t.item ) { return; }
			by[ t.item ] = ( by[ t.item ] || 0 ) + 1 + t.replies.length;
		} );
		app.toFrame( 'collab-pins', { pins: Object.keys( by ).map( function ( id ) { return { id: id, n: by[ id ] }; } ) } );
	}

	/* ---- presence ----------------------------------------------------------- */
	function pulse( leave ) {
		var data = { item: app.selectedId || '', device: app.device || 'desktop', dirty: app.dirty ? 1 : '' };
		if ( leave ) {
			if ( navigator.sendBeacon ) {
				var fd = new FormData();
				$.each( $.extend( { action: 'fw_le_collab', op: 'pulse', post_id: cfg.postId, nonce: cfg.nonce, leave: 1 }, data ), function ( k, v ) { fd.append( k, v ); } );
				navigator.sendBeacon( cfg.ajaxUrl, fd );
			}
			return;
		}
		call( 'pulse', data ).then( function ( d ) {
			S.others = d.others || [];
			presence();
			if ( S.stamp !== null && d.comments !== S.stamp ) { load(); }
			S.stamp = d.comments;
			var sv = d.saved || {};
			if ( sv.t && sv.t > S.seenSave ) {
				S.seenSave = sv.t;
				if ( sv.u && sv.u !== C.me.id ) { savedByOther( sv ); }
			}
		} );
	}
	function presence() {
		$pres.html( S.others.map( function ( o ) {
			var where = o.item && app.index[ o.item ] ? ' — on ' + itemLabel( o.item ) : '';
			var ini = String( o.name || '?' ).split( /\s+/ ).map( function ( w ) { return w.charAt( 0 ); } ).join( '' ).slice( 0, 2 ).toUpperCase();
			// Initials under the picture: they show when the avatar cannot load (offline, blocked).
			return '<span class="fw-le-presence__u" style="--c:' + esc( o.color ) + '" title="' + esc( o.name + where + ( o.dirty ? ' (unsaved changes)' : '' ) ) + '"><i>' + esc( ini ) + '</i>' +
				'<img src="' + esc( o.avatar ) + '" alt="' + esc( o.name ) + '" width="26" height="26" onerror="this.remove()"></span>';
		} ).join( '' ) );
		app.toFrame( 'collab-presence', { users: S.others.filter( function ( o ) { return o.item; } ).map( function ( o ) { return { id: o.item, name: o.name, color: o.color }; } ) } );
	}
	function savedByOther( sv ) {
		$( '.fw-le-savedby' ).remove();
		var $n = $( '<div class="fw-le-savedby" role="status"><span></span> <button type="button" class="button button-small">Reload</button> <button type="button" class="fw-le-savedby__x" aria-label="Dismiss">×</button></div>' ).appendTo( 'body' );
		$n.find( 'span' ).text( ( sv.name || 'Someone' ) + ' saved this page ' + ago( sv.t ) + '. Reload to see their changes' + ( app.dirty ? ' (your unsaved changes would be lost: saving now would replace theirs).' : '.' ) );
		$n.on( 'click', '.button', function () { window.location.reload(); } );
		$n.on( 'click', '.fw-le-savedby__x', function () { $n.remove(); } );
	}

	/* ---- staging ------------------------------------------------------------ */
	function stagingMenu() {
		$( '.fw-le-stagemenu' ).remove();
		var r = $sBtn[ 0 ].getBoundingClientRect();
		var $m = $( '<div class="fw-le-stagemenu" role="menu"></div>' ).css( { top: r.bottom + 6, right: Math.max( 8, window.innerWidth - r.right ) } ).appendTo( 'body' );
		if ( C.staging ) {
			$m.append( '<p>This is a <b>staging copy</b> of <a href="' + esc( C.staging.edit ) + '">' + esc( C.staging.title ) + '</a>. Changes here do not touch the live page.</p>' );
			$( '<button type="button" class="button">Share a review link…</button>' ).on( 'click', share ).appendTo( $m );
			$( '<button type="button" class="button button-primary">Publish to the live page…</button>' ).prop( 'disabled', ! C.staging.can ).on( 'click', publish ).appendTo( $m );
			$( '<button type="button" class="button fw-le-stagemenu__danger">Discard this copy…</button>' ).on( 'click', discard ).appendTo( $m );
		} else {
			$m.append( '<p>Make a <b>staging copy</b> of this page to change and review it before it goes live. The live page stays as it is until you publish the copy.</p>' );
			$( '<button type="button" class="button button-primary">Make a staging copy</button>' ).on( 'click', create ).appendTo( $m );
			if ( C.copies && C.copies.length ) {
				$m.append( '<p class="fw-le-stagemenu__sub">Staging copies of this page:</p>' );
				C.copies.forEach( function ( c ) {
					$m.append( '<a class="fw-le-stagemenu__copy" href="' + esc( c.edit ) + '">' + esc( 'By ' + c.by + ', changed ' + ago( c.modified ) ) + '</a>' );
				} );
			}
		}
		setTimeout( function () { $( document ).one( 'click.fwStage', function ( e ) { if ( ! $( e.target ).closest( '.fw-le-stagemenu, .fw-le-confirm' ).length ) { $m.remove(); } } ); }, 0 );
	}
	function needSaved() {
		if ( app.dirty ) { notify( 'Save your changes first: the copy uses the saved page.', 'warning' ); return true; }
		return false;
	}
	function create() {
		if ( needSaved() ) { return; }
		call( 'stage_create' ).then( function ( d ) { window.location.href = d.edit; }, function ( m ) { notify( m, 'error' ); } );
	}
	function share() {
		call( 'stage_share' ).then( function ( d ) {
			$( '.fw-le-stagemenu' ).remove();
			var $d = $( '<div class="fw-le-confirm-backdrop fw-le-share"><div class="fw-le-confirm" role="dialog" aria-modal="true"><div class="fw-le-confirm__title">Review link</div>' +
				'<div class="fw-le-confirm__msg">Anyone with this link can see this staging copy (as it was last saved) without logging in. Search engines are told not to index it.</div>' +
				'<input type="text" readonly class="fw-le-share__url"><div class="fw-le-confirm__actions"><button type="button" class="fw-le-confirm__btn fw-le-share__stop">Stop sharing</button><button type="button" class="fw-le-confirm__btn fw-le-share__copy">Copy link</button><button type="button" class="fw-le-confirm__btn fw-le-share__close">Done</button></div></div></div>' ).appendTo( 'body' );
			$d.find( 'input' ).val( d.url ).trigger( 'select' );
			$d.on( 'click', '.fw-le-share__copy', function () { var i = $d.find( 'input' )[ 0 ]; i.select(); ( navigator.clipboard ? navigator.clipboard.writeText( i.value ) : Promise.resolve( document.execCommand( 'copy' ) ) ).then( function () { notify( 'Link copied.', 'success' ); } ); } );
			$d.on( 'click', '.fw-le-share__close', function () { $d.remove(); } );
			$d.on( 'click', '.fw-le-share__stop', function () { call( 'stage_share', { off: 1 } ).then( function () { $d.remove(); notify( 'The review link no longer works.', 'success' ); } ); } );
		}, function ( m ) { notify( m, 'error' ); } );
	}
	function publish() {
		if ( needSaved() ) { return; }
		app.confirm( { title: 'Publish to the live page?', message: 'The live page "' + C.staging.title + '" is replaced by this copy (its content, settings and SEO). Its current version is kept in its Revision history, so it can be restored. This copy then goes to the trash.', confirmText: 'Publish' }, function () {
			call( 'stage_publish' ).then( function ( d ) { notify( 'Published to the live page.', 'success' ); window.location.href = d.edit; }, function ( m ) { notify( m, 'error' ); } );
		} );
	}
	function discard() {
		app.confirm( { title: 'Discard this staging copy?', message: 'The copy goes to the trash (it can be restored from there). The live page is not changed.', confirmText: 'Discard', danger: true }, function () {
			call( 'stage_discard' ).then( function ( d ) { window.location.href = d.edit; }, function ( m ) { notify( m, 'error' ); } );
		} );
	}
	if ( C.staging ) {
		$( '<div class="fw-le-stagebar">Staging copy of <b></b>: changes here do not touch the live page until you publish them. <button type="button" class="button button-small">Staging options</button></div>' )
			.find( 'b' ).text( C.staging.title ).end()
			.on( 'click', '.button', function ( e ) { e.stopPropagation(); stagingMenu(); } )
			.insertAfter( '#fw-le-toolbar' );
		$( 'body' ).addClass( 'fw-le-has-stagebar' );
	}

	/* ---- messages from the canvas ------------------------------------------- */
	window.fwLeCollab = {
		onFrame: function ( type, payload ) {
			var id = payload && payload.id;
			if ( type === 'collab-comment' ) {
				S.focus = id || null;
				panel( true, id || null );
				$p.find( '.fw-le-cpanel__new textarea' ).trigger( 'focus' );
			} else if ( type === 'collab-open-thread' ) {
				S.focus = id || null;
				panel( true, id || null );
				render();
			}
		},
		refreshPins: pins,
		state: S
	};

	// Tell the others at once when the selection changes (not only on the next pulse).
	var origSelect = app.onSelect, selT = 0;
	if ( typeof origSelect === 'function' ) {
		app.onSelect = function () {
			var r = origSelect.apply( this, arguments );
			clearTimeout( selT );
			selT = setTimeout( function () { pulse(); }, 500 );
			return r;
		};
	}

	// Pins and outlines are redrawn after every canvas re-render (undo, page render).
	var origReady = app.onFrameReady;
	if ( typeof origReady === 'function' ) {
		app.onFrameReady = function () { var r = origReady.apply( this, arguments ); setTimeout( function () { pins(); presence(); }, 600 ); return r; };
	}

	load();
	pulse();
	S.timer = setInterval( pulse, C.interval || 8000 );
	window.addEventListener( 'pagehide', function () { pulse( true ); } );
}( window.jQuery ) );
