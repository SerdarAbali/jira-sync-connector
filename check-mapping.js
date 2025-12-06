import Resolver from '@forge/resolver';
import * as kvsStore from './src/services/storage/kvs.js';

async function checkMapping() {
  // Check for SCRUM-142 mapping
  const orgs = await kvsStore.get('organizations') || [];
  console.log('Organizations:', orgs.map(o => o.id));
  
  for (const org of orgs) {
    const key1 = `${org.id}:local-to-remote:SCRUM-142`;
    const key2 = `local-to-remote:SCRUM-142`;
    
    const mapping1 = await kvsStore.get(key1);
    const mapping2 = await kvsStore.get(key2);
    
    console.log(`Org ${org.id}:`);
    console.log(`  ${key1}: ${JSON.stringify(mapping1)}`);
    console.log(`  ${key2}: ${JSON.stringify(mapping2)}`);
  }
}

checkMapping();
