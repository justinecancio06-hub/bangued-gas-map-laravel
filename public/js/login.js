/* Admin sign-in. */
(function () {
  'use strict';

  var form = document.getElementById('login-form');
  var username = document.getElementById('username');
  var password = document.getElementById('password');
  var submit = document.getElementById('submit');
  var errorBox = document.getElementById('login-error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() {
    errorBox.hidden = true;
  }

  /**
   * Where a signed-in account belongs. Admins get the dashboard; a
   * station_manager has no dashboard of their own - they price their station
   * from the public map - so they are sent there instead.
   */
  function homeFor(user) {
    return user && user.role === 'station_manager' ? '/' : '/admin';
  }

  // Already signed in? Skip straight to the page that role works from.
  Api.me()
    .then(function (resp) { window.location.replace(homeFor(resp && resp.data)); })
    .catch(function () { /* not signed in - show the form */ });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    clearError();

    var user = username.value.trim();
    var pass = password.value;

    if (!user || !pass) {
      showError('Enter both username and password.');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Signing in…';

    try {
      var resp = await Api.login(user, pass);
      // Remember the username only - never the password.
      try { localStorage.setItem('bgm.username', user); } catch (err) { /* ignore */ }
      window.location.replace(homeFor(resp && resp.data));
    } catch (err) {
      showError(err.message || 'Sign in failed.');
      password.value = '';
      password.focus();
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
})();
