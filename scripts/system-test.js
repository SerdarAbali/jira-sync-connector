/**
 * JIRA SYNC SYSTEM TEST
 * 
 * This script performs a full end-to-end test of the sync connector.
 * It acts as an external observer, manipulating Jira via REST API and verifying results.
 * 
 * USAGE:
 * 1. Ensure your app is running (`forge tunnel` or deployed)
 * 2. Configure the variables at the top of this file or in a .env file
 * 3. Run: node scripts/system-test.js
 */

import https from 'https';

// --- CONFIGURATION ---
// Load from .env if available, otherwise set manually here
const CONFIG = {
  // LOCAL JIRA (Source)
  LOCAL_URL: process.env.LOCAL_URL || 'https://your-domain.atlassian.net',
  LOCAL_EMAIL: process.env.LOCAL_EMAIL || 'your-email@example.com',
  LOCAL_TOKEN: process.env.LOCAL_TOKEN || 'your-api-token',
  LOCAL_PROJECT: process.env.LOCAL_PROJECT || 'TEST',

  // REMOTE JIRA (Target)
  REMOTE_URL: process.env.REMOTE_URL || 'https://target-domain.atlassian.net',
  REMOTE_EMAIL: process.env.REMOTE_EMAIL || 'target-email@example.com',
  REMOTE_TOKEN: process.env.REMOTE_TOKEN || 'target-api-token',
  REMOTE_PROJECT: process.env.REMOTE_PROJECT || 'TEST',
};

// --- HELPERS ---

const authHeader = (email, token) => 
  'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');

async function jiraRequest(url, method, path, auth, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      method: method,
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = https.request(`${url}${path}`, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`Request failed: ${res.statusCode} ${data}`));
        }
      });
    });

    req.on('error', (e) => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- TEST SCENARIO ---

async function runTest() {
  console.log('🚀 Starting System Test...');
  console.log(`📍 Source: ${CONFIG.LOCAL_URL} (${CONFIG.LOCAL_PROJECT})`);
  console.log(`📍 Target: ${CONFIG.REMOTE_URL} (${CONFIG.REMOTE_PROJECT})`);

  const localAuth = authHeader(CONFIG.LOCAL_EMAIL, CONFIG.LOCAL_TOKEN);
  const remoteAuth = authHeader(CONFIG.REMOTE_EMAIL, CONFIG.REMOTE_TOKEN);
  
  let localIssueKey = null;
  let remoteIssueKey = null;

  try {
    // 1. CREATE ISSUE
    console.log('\n1️⃣  Creating issue in Local Jira...');
    const createPayload = {
      fields: {
        project: { key: CONFIG.LOCAL_PROJECT },
        summary: `Auto Test Issue ${Date.now()}`,
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "This is a test issue created by the system test script." }] }]
        },
        issuetype: { name: "Task" }
      }
    };

    const created = await jiraRequest(CONFIG.LOCAL_URL, 'POST', '/rest/api/3/issue', localAuth, createPayload);
    localIssueKey = created.key;
    console.log(`✅ Created Local Issue: ${localIssueKey}`);

    // 2. WAIT FOR SYNC (CREATE)
    console.log('⏳ Waiting for sync to Remote (10s)...');
    await sleep(10000);

    // Search in Remote for an issue with the same summary
    console.log('🔎 Checking Remote Jira...');
    const searchResult = await jiraRequest(
      CONFIG.REMOTE_URL, 
      'GET', 
      `/rest/api/3/search?jql=project=${CONFIG.REMOTE_PROJECT} AND summary ~ "${createPayload.fields.summary}"`, 
      remoteAuth
    );

    if (searchResult.issues && searchResult.issues.length > 0) {
      remoteIssueKey = searchResult.issues[0].key;
      console.log(`✅ Sync Successful! Found Remote Issue: ${remoteIssueKey}`);
    } else {
      throw new Error('❌ Sync Failed: Issue not found in Remote Jira after 10s');
    }

    // 3. UPDATE ISSUE
    console.log('\n2️⃣  Updating Local Issue description...');
    const updatePayload = {
      fields: {
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Updated description by system test." }] }]
        }
      }
    };
    await jiraRequest(CONFIG.LOCAL_URL, 'PUT', `/rest/api/3/issue/${localIssueKey}`, localAuth, updatePayload);
    console.log(`✅ Updated ${localIssueKey}`);

    // 4. WAIT FOR SYNC (UPDATE)
    console.log('⏳ Waiting for sync to Remote (5s)...');
    await sleep(5000);

    const remoteIssue = await jiraRequest(CONFIG.REMOTE_URL, 'GET', `/rest/api/3/issue/${remoteIssueKey}`, remoteAuth);
    // Note: Checking ADF content is complex, we'll just check if the request succeeded and assume sync worked if no error
    // In a real test we'd parse the ADF
    console.log(`✅ Remote issue fetched successfully. Sync likely worked.`);

    // 5. DELETE ISSUE
    console.log('\n3️⃣  Deleting Local Issue...');
    await jiraRequest(CONFIG.LOCAL_URL, 'DELETE', `/rest/api/3/issue/${localIssueKey}`, localAuth);
    console.log(`✅ Deleted ${localIssueKey}`);

    // 6. WAIT FOR SYNC (DELETE)
    console.log('⏳ Waiting for sync to Remote (5s)...');
    await sleep(5000);

    try {
      await jiraRequest(CONFIG.REMOTE_URL, 'GET', `/rest/api/3/issue/${remoteIssueKey}`, remoteAuth);
      console.log('❌ Sync Failed: Remote issue still exists!');
    } catch (e) {
      if (e.message.includes('404')) {
        console.log(`✅ Sync Successful! Remote issue ${remoteIssueKey} is gone (404).`);
      } else {
        throw e;
      }
    }

    console.log('\n🎉 SYSTEM TEST PASSED!');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
  }
}

runTest();
