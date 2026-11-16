# App Android (Capacitor)

O APK de debug (`../Teleprompter-debug.apk`) foi compilado com sucesso, mas **não foi testado em aparelho**.
Modo padrão: app autônomo (arquivos embutidos; sem remoto/e-mail). Para ligar ao seu servidor: `CAP_SERVER_URL=https://seu-servidor npm run build:apk`.
Voz: usa o plugin nativo `speech-recognition` (o WebView do Android não tem `webkitSpeechRecognition`).
Para loja é preciso assinar o app (keystore) e gerar `assembleRelease`.

(histórico abaixo)

Empacota o teleprompter como app Android/iOS carregando o seu servidor (`server.url` em `capacitor.config.json`).
Ganhos reais: permissão de microfone nativa, tela sempre ligada, travar orientação, ícone/loja.

```bash
cd mobile && npm install
# edite capacitor.config.json -> server.url
npm run add:android   # requer Android Studio/SDK
npm run open:android
```
Android: adicione `RECORD_AUDIO` ao AndroidManifest; iOS: `NSMicrophoneUsageDescription` e `NSSpeechRecognitionUsageDescription` no Info.plist.

## Bluetooth
- **Clickers/pedais BLE HID** já funcionam (viram teclado) — web e nativo.
- Fazer o celular **ser** um periférico BLE (para outro celular conectar direto sem internet) exige plugin nativo
  customizado (GATT server); não há plugin pronto confiável. A alternativa implementada é o controle via servidor (Wi‑Fi/internet).
