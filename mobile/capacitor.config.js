// Sem CAP_SERVER_URL: app autônomo (arquivos embutidos). Com ela: carrega seu servidor (habilita remoto/e-mail/login).
const url = process.env.CAP_SERVER_URL;
module.exports = {
  appId: 'app.teleprompter',
  appName: 'TELEPROMPTER UNIÃO',
  webDir: 'www',
  ...(url ? { server: { url, cleartext: url.startsWith('http://') } } : {}),
};
