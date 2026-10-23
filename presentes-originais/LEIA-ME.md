# Imagens dos presentes

Coloque aqui uma imagem de cada presente da lista (JPG, PNG ou WebP, em boa qualidade).

- **Nome do arquivo:** o nome do presente (`camera-polaroid.jpg`, `fone-jbl.png`…) ou um número na ordem
  da lista (`1.jpg`, `2.jpg`…), **sem acentos nem espaços**. Uma imagem por presente.
- **Como fotografar ou escolher:** o produto inteiro, sem texto por cima; fundo claro ajuda.
- A lista em si (nome, tipo, valor ou meta, descrição, link) vai na conversa com o Claude; ele monta
  `src/content/gifts.ts`.
- As imagens são otimizadas para o site (a foto entra no lugar do ícone, no cartão do pergaminho e na
  página do presente) e para o item da página de pagamento do Asaas (`public/presentes/<id>.png`).

Os arquivos desta pasta **não** são versionados (veja `.gitignore`): fotos de sites de lojas têm dono, e o
repositório vai ser público. As versões otimizadas também ficam fora do git até a família decidir (como a
música, entram só no build feito nesta máquina).
