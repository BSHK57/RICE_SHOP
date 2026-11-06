/*
 * login.js - behaviour of templates/login.html (standalone: does not use the App namespace).
 * POSTs /api/auth/login (CSRF-exempt), then reloads "/" - the server now renders the shell.
 * The URL never changes.
 */
(function () {
  'use strict';
  var form = document.getElementById('login-form');
  var user = document.getElementById('username');
  var pass = document.getElementById('password');
  var errBox = document.getElementById('login-error');
  var btn = document.getElementById('login-btn');
  var spin = document.getElementById('login-spin');
  var label = document.getElementById('login-label');
  var toggle = document.getElementById('toggle-pw');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }
  function busy(on) {
    btn.disabled = on;
    spin.classList.toggle('hidden', !on);
    label.textContent = on ? 'Signing in…' : 'Sign in';
  }

  toggle.addEventListener('click', function () {
    var show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', show ? 'true' : 'false');
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    document.getElementById('pw-eye').classList.toggle('hidden', show);
    document.getElementById('pw-eye-off').classList.toggle('hidden', !show);
    pass.focus();
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    errBox.classList.add('hidden');
    var u = user.value.trim();
    if (!u || !pass.value) {
      showError('Please enter your username and password.');
      (u ? pass : user).focus();
      return;
    }
    busy(true);
    fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ username: u, password: pass.value }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (res.ok && json && json.ok) { window.location.reload(); return; }
        busy(false);
        showError((json && json.error) || (res.status === 429 ? 'Too many attempts. Please wait a few minutes.' : 'Could not sign in. Please try again.'));
        pass.select();
      });
    }).catch(function () {
      busy(false);
      showError('Could not reach the server. Check your connection and try again.');
    });
  });
})();
