# Log da conversa — Lightshot (prnt.sc) como imagem no chat (Social Stream)

## Objetivo
Fazer links do **Lightshot** (ex.: `https://prnt.sc/YQ53a41fxk9C`) aparecerem como **imagem** no chat do Social Stream, em vez de aparecerem só como texto/link.

## Contexto importante do ambiente
- O usuário roda o **APP DESKTOP (Electron)** do Social Stream — NÃO a extensão do Chrome nem a versão web.
- Indício: barra de menu "Direção de cenas | Ferramentas (T) | Ajuda (H)".
- Sistema operacional: **Windows** (interface em português).
- O usuário instalou/usa via repositório.

## Repositório usado neste trabalho
- Repo: `Asrus21/social_stream` (fork).
- Branch de desenvolvimento: `claude/pensive-shannon-dd60ly`.
- PR #1 já foi **mergeado**: https://github.com/Asrus21/social_stream/pull/1
- **ATENÇÃO:** este repositório é a **versão extensão/web**. O app desktop (Electron) é um **build separado** que empacota esses arquivos. Por isso, trocar arquivos soltos numa pasta de download NÃO afeta o app desktop instalado.

---

## Descoberta técnica central (por que é difícil)
Links `prnt.sc` / `prntscr.com` **NÃO são URLs diretas de imagem** — são páginas HTML.
A imagem real fica em `image.prntscr.com/...` e só é exposta na meta tag `<meta property="og:image">` da página.

**Problema:** a página do prnt.sc é **protegida por Cloudflare** e **bloqueia leituras automáticas** (fetch da extensão/servidor recebe 403 / desafio, não o HTML). Além disso, no Manifest V3 o `fetch` da extensão **não consegue forjar User-Agent** de crawler, então não dá pra contornar o Cloudflare de dentro da extensão de forma confiável.

**Decisão tomada (com o usuário):** resolver o link através de um serviço de "unfurl"/proxy com navegador headless (**microlink.io**), que abre o prnt.sc, extrai a imagem real e a entrega direto para a tag `<img>`. (O usuário consentiu em usar serviço externo.)

---

## Implementação feita (no repositório, em `background.js`)
A lógica foi inserida na função `applyBotActions(data, tab)` (processamento principal de mensagens recebidas, chamada em `background.js:4429`).

Versão final do trecho (SEM toggle, sempre ligado), localizada logo após o bloco de Giphy/Tenor (~linha 15883) em `background.js`:

```js
// Lightshot (prnt.sc) screenshot links -> inline image in chat.
// prnt.sc/prntscr.com pages are behind Cloudflare and block direct reads,
// so the extension cannot scrape the og:image itself. Instead we point the
// <img> at Microlink, which renders the page and streams back the underlying
// screenshot (image.prntscr.com) via its embed shortcut.
if (data.chatmessage && !data.contentimg) {
	try {
		const lightshotMatch = data.chatmessage.match(/https?:\/\/(?:www\.)?(?:prnt\.sc|prntscr\.com)\/[A-Za-z0-9]{4,}/i);
		if (lightshotMatch) {
			const lightshotUrl = lightshotMatch[0].replace(/^http:/, "https:");
			data.contentimg = "https://api.microlink.io/?url=" + encodeURIComponent(lightshotUrl) + "&embed=image.url";
		}
	} catch (e) {
		console.error("Lightshot embed error:", e);
	}
}
```

O que isso faz: detecta o link do prnt.sc na mensagem e define `data.contentimg` apontando para o microlink, que entrega a imagem. O dock renderiza `contentimg` como `<img>`.

### Confirmação de que o dock renderiza a imagem
Em `dock.html` (~linha 10498-10502), o dock monta a imagem assim:
```js
if (data.contentimg) {
	if (data.contentimg.includes('.mp4') || data.contentimg.includes('.webm')){
		addImage = '<div class="hl-imgContent"><video autoplay ... src="'+data.contentimg+'" ...></video></div>';
	} else {
		addImage = '<div class="hl-imgContent"><img src="'+data.contentimg+'" onerror="this.style.display=\'none\';" /></div>';
	}
}
```
Observação: imagens de conteúdo no dock têm altura limitada via CSS `--content-images` (~30-36px). Ou seja, mesmo funcionando, a miniatura no dock é pequena.

### Versão alternativa anterior (descartada)
A 1ª versão tentava fazer `fetch` da página do prnt.sc no background e extrair o `og:image`. **Não funciona** por causa do bloqueio do Cloudflare. Foi substituída pela versão microlink acima.

### Toggle (opcional, hoje irrelevante)
Antes havia um toggle "Show Lightshot (prnt.sc) screenshot links as inline images" em:
- `shared/config/settingsDefinitions.js` (setting `lightshot`)
- `popup.html` (checkbox na seção "Giphy/Tenor support")
A versão final removeu a dependência do toggle (sempre ligado), então **só o `background.js` importa**.

---

## STATUS ATUAL / PROBLEMA EM ABERTO
O usuário substituiu o `background.js` e recarregou, mas **o link continua aparecendo como texto** (sem imagem).

**Causa mais provável:** no app desktop (Electron), os arquivos ficam **empacotados** (provavelmente em `resources/app.asar` ou em `resources/app/`). O `background.js` editado numa pasta solta (ex.: a pasta baixada do GitHub em Downloads) **não é o que o app realmente executa**. Por isso a alteração não tem efeito.

> Observação técnica: no Electron, o `background.js` roda como uma página normal (tem `window`/`document`/`localStorage`), não como service worker. Isso bate com o código existente (`loadCustomJs` usa `document`).

### Recurso "Upload Script" (custom JS) — NÃO confiável
O app tem um botão "Upload custom JavaScript" e a pipeline chama `customUserFunction(data)` em `background.js:16083`. PORÉM, a função `loadCustomJs` (`background.js:1037`) está **quebrada**: ela não executa o corpo da função enviada (usa um `processCustomFunctionBody` fixo/hardcoded). Logo, **não dá pra confiar nesse recurso** para injetar a lógica do Lightshot.

---

## PRÓXIMO PASSO (o que investigar no novo chat)
Descobrir **onde o app desktop instalado guarda o `background.js`** e substituir o arquivo CERTO (ou orientar extração/repack do `app.asar`).

No Windows, o app Electron normalmente fica em um destes lugares:
- `C:\Users\<SEU_USUARIO>\AppData\Local\Programs\<Nome do App>\resources\`
- `C:\Program Files\<Nome do App>\resources\`

Dentro de `resources\`, procurar:
- **`app\`** (pasta) → app DESEMPACOTADO. Basta substituir `resources\app\background.js`.
- **`app.asar`** (arquivo único) → app EMPACOTADO. Precisa extrair/repack com `npx asar` (ou usar a flag de unpack), OU regerar o build a partir do fork já com a alteração.

### Como achar a pasta no Windows
1. Menu Iniciar → botão direito no atalho do Social Stream → "Abrir local do arquivo".
2. Se cair numa pasta de atalhos, repita "Abrir local do arquivo" no executável.
3. Suba até achar a pasta `resources`.
4. Verificar se existe `app\` (pasta) ou `app.asar` (arquivo).

**No novo chat, mostrar:** o conteúdo da pasta de instalação do app (print/lista de arquivos da pasta `resources`), pra decidir entre: (a) substituir `app\background.js`, ou (b) extrair/repack o `app.asar`, ou (c) gerar um build do fork.

---

## Resumo de 1 linha para colar no novo chat
> "Quero que links do Lightshot (prnt.sc) virem imagem no chat do Social Stream. Uso o APP DESKTOP (Electron) no Windows, instalado via repositório (fork Asrus21/social_stream, PR #1 mergeado). A alteração no background.js (usa microlink para resolver o prnt.sc) já está pronta no repo, mas editar o arquivo solto não afeta o app empacotado. Preciso descobrir onde o app instalado guarda o background.js (resources/app/ ou resources/app.asar) e aplicar a mudança ali. Segue o log e a pasta de instalação."
