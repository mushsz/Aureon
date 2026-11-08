// Sinal de leitura da análise: só conta se a página ficar visível por 4 segundos
// (robôs de segurança de e-mail baixam o link mas não executam isto).
(function () {
  var sent = false;
  function send() {
    if (sent || document.visibilityState !== 'visible') return;
    sent = true;
    fetch(location.pathname.replace(/\/$/, '') + '/visto', { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: '{}' }).catch(function () {});
  }
  setTimeout(send, 4000);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(send, 4000); });
})();
