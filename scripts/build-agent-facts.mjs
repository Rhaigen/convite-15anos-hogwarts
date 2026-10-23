/**
 * Gera, a partir de src/content/, os arquivos que as Edge Functions usam:
 *   supabase/functions/_shared/eventFacts.ts      (fatos da festa para a Aifos)
 *   supabase/functions/_shared/gifts/catalog.ts   (lista de presentes com preços, para o checkout)
 *   supabase/functions/_shared/gifts/pricing.ts   (cópia da fórmula de preço do site)
 * Rode depois de mudar data, local, textos, Pix ou presentes:
 *   npm run agent:facts
 * (O Vite carrega os módulos TypeScript do site sem build.)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { runnerImport } from 'vite';

const load = async (file) => (await runnerImport(file, { configFile: false, logLevel: 'error' })).module;

const facts = await load('./scripts/lib/agent-facts.ts');
const factsTarget = 'supabase/functions/_shared/eventFacts.ts';
writeFileSync(factsTarget, facts.renderEventFactsModule());
console.log(`Fatos da festa atualizados em ${factsTarget}`);

const gifts = await load('./scripts/lib/gift-catalog.ts');
// Imagem dos itens no checkout do Asaas: o brasão da Sofia sobre o pergaminho, PNG pequeno
// (o Asaas recusou o JPEG do sharp, que sai sem o cabeçalho JFIF: "Extensão não suportada").
const image = await sharp('src/assets/brasoes/sofia-280.webp')
  .resize(200, 200, { fit: 'contain', background: '#e9d7b0' })
  .flatten({ background: '#e9d7b0' })
  .png({ palette: true, compressionLevel: 9 })
  .toBuffer();
mkdirSync(dirname(gifts.CATALOG_PATH), { recursive: true });
writeFileSync(gifts.CATALOG_PATH, gifts.renderGiftCatalogModule(image.toString('base64')));
writeFileSync(gifts.PRICING_PATH, gifts.renderPricingModule());
console.log(`Lista de presentes do servidor atualizada em ${gifts.CATALOG_PATH} e ${gifts.PRICING_PATH}`);
