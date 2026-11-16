# TELEPROMPTER UNIÃO

PWA (celular/tablet/PC) + servidor Node para controle remoto e recebimento de texto por e-mail.

```bash
npm install
npm start            # http://localhost:3000
```
> O microfone só funciona em `localhost` ou **HTTPS**. Para usar no celular, publique com HTTPS
> (ex.: Render/Fly/VPS + Caddy, ou um túnel como `cloudflared tunnel --url http://localhost:3000`).

## Modos de rolagem
- **Seguir minha voz**: reconhecimento de fala (Chrome/Edge/Android/Safari). Compara o que você fala com o texto e posiciona a palavra atual na linha-guia. Palavras lidas escurecem.
- **Rolar enquanto eu falar**: usa o volume do microfone; rola na velocidade escolhida enquanto há voz e para nas pausas.
- **Automático**: velocidade fixa.

## Controle de outro aparelho
- **Bluetooth**: teclados/clickers/pedais Bluetooth pareados ao aparelho funcionam como teclado:
  `Espaço/Enter/.` play-pause · `↑/↓` velocidade · `←/→ PgUp/PgDn` voltar/avançar · `+/-` fonte · `M` espelho · `R` reiniciar · `Esc` sair.
- **Celular como controle**: botão "Controle remoto" mostra QR/link de `/remote?room=CÓDIGO` (via WebSocket, Wi-Fi ou internet).
  Navegadores não conseguem agir como periférico Bluetooth, por isso o app-controle usa o servidor.

## Receber texto por e-mail
Habilite uma (ou ambas) opções e use o botão "📧 E-mail" no app:
1. **IMAP** (Gmail, Outlook…): `IMAP_HOST=imap.gmail.com IMAP_USER=voce@gmail.com IMAP_PASS=<senha de app> npm start`
   (opcionais: `IMAP_PORT`, `IMAP_FOLDER`, `IMAP_POLL_SEC`). Novos e-mails não lidos viram scripts (assunto = título).
2. **Webhook**: `INBOUND_TOKEN=segredo npm start` e envie `POST /api/inbound-email?token=segredo` com JSON `{subject, from, text}`
   (Zapier, n8n, Cloudflare Email Workers, SendGrid Inbound Parse em modo urlencoded…).

> Segurança: a caixa de entrada e o remoto não têm login. Publique atrás de HTTPS e, idealmente, de autenticação (proxy).

## Login
Defina `APP_PASSWORD=sua-senha` para exigir login (cookie HttpOnly de 30 dias, limite de tentativas, vale também para WebSocket e API).
O celular de controle faz login uma vez ao abrir o link `/remote`. O webhook de e-mail usa `INBOUND_TOKEN` e não precisa de login.

## Deploy (HTTPS)
- **Docker:** `docker build -t teleprompter . && docker run -p 3000:3000 -e APP_PASSWORD=... -v tpdata:/app/data teleprompter`
- **Render:** conecte o repositório (usa `render.yaml`) e defina `APP_PASSWORD` no painel. Obs.: no plano free o disco é efêmero (e-mails recebidos se perdem a cada reinício).
- **Fly.io:** `fly launch --copy-config` (usa `fly.toml`), `fly volumes create tp_data`, `fly secrets set APP_PASSWORD=...`.

## App nativo
Veja `mobile/README.md` (Capacitor; scaffold sem build testado).

## Idiomas
PT, EN, ES, FR, DE, IT (interface e reconhecimento de voz).
