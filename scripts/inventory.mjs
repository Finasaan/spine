import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.dev.vars');

function loadEnv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const env = {};
  content.split('\n').forEach(line => {
    const [key, ...value] = line.split('=');
    if (key && value) {
      env[key.trim()] = value.join('=').trim();
    }
  });
  return env;
}

async function run() {
  const env = loadEnv(envPath);
  const supabaseUrl = env.SUPABASE_URL;
  const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_KEY in .dev.vars');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('--- Database Inventory ---');

  // 1. Count of extracted_tables rows
  const { count, error: countError } = await supabase
    .from('extracted_tables')
    .select('*', { count: 'exact', head: true });

  if (countError) console.error('Error counting extracted_tables:', countError);
  else console.log(`Total extracted_tables: ${count}`);

  // 2. Distinct (company_id, company_name) values
  const { data: companies, error: companyError } = await supabase
    .from('extracted_tables')
    .select('company_id, company_name');
  
  if (companyError) {
    console.error('Error fetching companies:', companyError);
  } else {
    const distinctCompanies = Array.from(
      new Set(companies.map(c => `${c.company_id || 'null'}|${c.company_name}`))
    ).map(s => {
      const [id, name] = s.split('|');
      return { company_id: id === 'null' ? null : id, company_name: name };
    });
    console.log('\nDistinct Companies in extracted_tables:');
    console.table(distinctCompanies);
  }

  // 3. Distinct fiscal_period values
  const { data: periods, error: periodError } = await supabase
    .from('extracted_tables')
    .select('fiscal_period');
  
  if (periodError) {
    console.error('Error fetching periods:', periodError);
  } else {
    const distinctPeriods = Array.from(new Set(periods.map(p => p.fiscal_period))).sort();
    console.log('\nDistinct Fiscal Periods in extracted_tables:');
    console.log(distinctPeriods.join(', '));
  }

  // 4. Distinct metadata->>'company' and metadata->>'period' from finasaan_documents
  // Note: Supabase JS client doesn't support distinct on JSONB easily without raw RPC,
  // but we can fetch and process in JS if the dataset isn't massive.
  const { data: docs, error: docError } = await supabase
    .from('finasaan_documents')
    .select('metadata');

  if (docError) {
    console.error('Error fetching finasaan_documents:', docError);
  } else {
    const distinctDocMeta = Array.from(
      new Set(docs.map(d => `${d.metadata?.company || 'null'}|${d.metadata?.period || 'null'}`))
    ).map(s => {
      const [company, period] = s.split('|');
      return { 
        company: company === 'null' ? null : company, 
        period: period === 'null' ? null : period 
      };
    });
    console.log('\nDistinct Company/Period in finasaan_documents:');
    console.table(distinctDocMeta);
  }
}

run().catch(console.error);
