import { parseHTML } from 'linkedom';

// Store active polling jobs
const activeJobs = new Map();

// Store cookies for each job (to maintain separate sessions)
const jobCookies = new Map();

// Helper function to parse cookies from Set-Cookie header
function parseCookies(setCookieHeader) {
  const cookies = {};
  if (!setCookieHeader) return cookies;
  
  const cookieArray = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  cookieArray.forEach(cookie => {
    const parts = cookie.split(';')[0].split('=');
    if (parts.length === 2) {
      cookies[parts[0].trim()] = parts[1].trim();
    }
  });
  return cookies;
}

// Helper function to format cookies for Cookie header
function formatCookies(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

// Helper function to parse HTML response and extract names and dates
function parseCertificateData(htmlData) {
  const { document } = parseHTML(htmlData);
  const records = [];
  
  // Try multiple selectors to ensure we get all rows
  let rows = document.querySelectorAll('#death-table tbody tr');
  
  if (rows.length === 0) {
    rows = document.querySelectorAll('table tbody tr');
  }
  if (rows.length === 0) {
    rows = document.querySelectorAll('.table tbody tr');
  }
  if (rows.length === 0) {
    rows = document.querySelectorAll('tbody tr');
  }
  
  rows.forEach((row) => {
    const cells = row.querySelectorAll('td');
    if (cells.length >= 6) {
      const name = cells[1]?.textContent?.trim() || '';
      const gender = cells[2]?.textContent?.trim() || '';
      const dateOfDeath = cells[3]?.textContent?.trim() || '';
      const fathersName = cells[4]?.textContent?.trim() || '';
      const mothersName = cells[5]?.textContent?.trim() || '';
      
      if (name && name !== '.......' && name !== '...' && name.length > 0) {
        records.push({
          name,
          gender,
          dateOfDeath,
          fathersName,
          mothersName
        });
      }
    }
  });
  
  console.log(`Parsed ${records.length} records from HTML`);
  return records;
}

// Helper function to normalize names for matching
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper function to check if name matches with match quality score
function nameMatches(searchName, recordName) {
  if (!searchName || !recordName) return { match: false, score: 0, matchedPart: '' };
  
  const cleanSearch = searchName.trim();
  const cleanRecord = recordName.trim();
  
  const normalizedSearch = normalizeName(cleanSearch);
  const normalizedRecord = normalizeName(cleanRecord);
  
  if (normalizedSearch === normalizedRecord) {
    return { match: true, score: 100, matchedPart: recordName };
  }
  
  const searchParts = normalizedSearch.split(/[\s.]+/).filter(w => w.length > 0);
  const recordParts = normalizedRecord.split(/[\s.]+/).filter(w => w.length > 0);
  
  const longestSearchPart = searchParts.reduce((longest, part) => 
    part.length > longest.length ? part : longest, '');
  
  if (longestSearchPart.length < 3) {
    return { match: false, score: 0, matchedPart: '' };
  }
  
  const hasMainMatch = recordParts.some(recordPart => 
    recordPart.includes(longestSearchPart) || longestSearchPart.includes(recordPart)
  );
  
  if (!hasMainMatch) {
    return { match: false, score: 0, matchedPart: '' };
  }
  
  if (normalizedRecord.includes(normalizedSearch)) {
    const score = Math.min(100, (normalizedSearch.length / normalizedRecord.length) * 100);
    if (score >= 50) {
      return { match: true, score: Math.min(score, 100), matchedPart: recordName };
    }
  }
  
  if (longestSearchPart.length >= 4) {
    const mainPartMatchLength = recordParts
      .filter(rp => rp.includes(longestSearchPart) || longestSearchPart.includes(rp))
      .reduce((max, rp) => Math.max(max, rp.length), 0);
    
    if (mainPartMatchLength >= longestSearchPart.length) {
      const score = Math.min(100, (longestSearchPart.length / Math.max(normalizedRecord.length, longestSearchPart.length)) * 100);
      if (score >= 60) {
        return { match: true, score: Math.min(score, 100), matchedPart: recordName };
      }
    }
  }
  
  return { match: false, score: 0, matchedPart: '' };
}

// Helper function to generate dates between start and end
function getDatesInRange(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(new Date(d).toISOString().split('T')[0]);
  }
  
  return dates;
}

// Function to initialize session and get CSRF token
async function initializeSession(jobId, verificationNumber) {
  try {
    const cookies = jobCookies.get(jobId) || {};
    
    const response = await fetch('http://27.100.26.138/death-certificate', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': formatCookies(cookies)
      }
    });

    // Update cookies from response
    const setCookieHeader = response.headers.get('Set-Cookie');
    if (setCookieHeader) {
      const newCookies = parseCookies(setCookieHeader);
      Object.assign(cookies, newCookies);
      jobCookies.set(jobId, cookies);
    }

    const htmlData = await response.text();
    const { document } = parseHTML(htmlData);
    
    let csrfToken = null;
    let extractedVerificationNumber = null;
    
    const metaToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
    if (metaToken) {
      csrfToken = metaToken;
    } else {
      const formToken = document.querySelector('input[name="_token"]')?.getAttribute('value');
      if (formToken) {
        csrfToken = formToken;
      } else {
        const xsrfCookie = cookies['XSRF-TOKEN'];
        if (xsrfCookie) {
          csrfToken = xsrfCookie;
        }
      }
    }

    if (!csrfToken) {
      throw new Error('Could not extract CSRF token from page');
    }

    const captchaElement = document.querySelector('.captcha-number') || 
                          document.querySelector('span.input-group-text.captcha-number');
    if (captchaElement) {
      extractedVerificationNumber = captchaElement.textContent?.trim();
    }
    
    if (!extractedVerificationNumber) {
      const captchaInput = document.querySelector('input[name="verification_number"]');
      if (captchaInput) {
        const parent = captchaInput.closest('.input-group');
        if (parent) {
          const captchaSpan = parent.querySelector('.captcha-number');
          if (captchaSpan) {
            extractedVerificationNumber = captchaSpan.textContent?.trim();
          }
        }
      }
    }

    const finalVerificationNumber = verificationNumber || extractedVerificationNumber;
    
    if (!finalVerificationNumber) {
      console.warn('Could not extract verification number from page. You may need to provide it manually.');
    } else {
      console.log(`Verification number ${extractedVerificationNumber ? 'extracted' : 'provided'}: ${finalVerificationNumber}`);
    }
    
    return {
      csrfToken,
      verificationNumber: finalVerificationNumber
    };
  } catch (error) {
    console.error(`Error initializing session for job ${jobId}:`, error.message);
    throw error;
  }
}

// Function to poll API for a specific date
async function pollForDate(jobId, verificationNumber, csrfToken, date, gender) {
  try {
    const cookies = jobCookies.get(jobId);
    if (!cookies) {
      return {
        success: false,
        error: 'Session not initialized. Cookies not found.',
        date
      };
    }

    const params = new URLSearchParams({
      dod: date,
      gender: gender,
      verification_number: verificationNumber,
      _token: csrfToken
    });

    const response = await fetch('http://27.100.26.138/death/fetch-certificates', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'http://27.100.26.138/death-certificate',
        'Cookie': formatCookies(cookies)
      },
      body: params.toString()
    });

    // Update cookies from response
    const setCookieHeader = response.headers.get('Set-Cookie');
    if (setCookieHeader) {
      const newCookies = parseCookies(setCookieHeader);
      Object.assign(cookies, newCookies);
      jobCookies.set(jobId, cookies);
    }

    if (response.status === 419) {
      return {
        success: false,
        error: 'CSRF token expired. Session needs to be reinitialized.',
        date,
        needsReinit: true
      };
    }

    const data = await response.json();

    if (data && data.status && data.data) {
      return {
        success: true,
        data: data.data,
        date
      };
    } else {
      return {
        success: false,
        error: 'Invalid response format',
        date
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Request failed',
      date
    };
  }
}

// Main polling function
async function startPollingJob(jobId, verificationNumber, providedToken, dates, gender, searchName, intervalMinutes, kvStore = null) {
  const job = await getJobFromKV(jobId, kvStore);
  if (!job) return;

  const pollInterval = intervalMinutes * 60 * 1000;
  let csrfToken = providedToken;
  let finalVerificationNumber = verificationNumber;

  try {
    job.status = 'initializing';
    job.lastUpdate = new Date().toISOString();
    await saveJobToKV(jobId, job, kvStore);
    
    console.log(`Initializing session for job ${jobId}...`);
    const sessionData = await initializeSession(jobId, verificationNumber);
    
    if (!csrfToken) {
      csrfToken = sessionData.csrfToken;
      console.log(`CSRF token extracted from page`);
    }
    
    if (!finalVerificationNumber && sessionData.verificationNumber) {
      finalVerificationNumber = sessionData.verificationNumber;
      console.log(`Using extracted verification number: ${finalVerificationNumber}`);
    }
    
    if (!finalVerificationNumber) {
      throw new Error('Verification number is required. Please provide it or ensure it can be extracted from the page.');
    }
    
    if (!csrfToken) {
      throw new Error('CSRF token is required. Could not extract from page.');
    }
    
    console.log(`Session initialized. Ready to start polling for job ${jobId}`);
    job.status = 'running';
    await saveJobToKV(jobId, job, kvStore);
  } catch (error) {
    job.status = 'error';
    job.errors.push({
      date: 'initialization',
      error: `Failed to initialize session: ${error.message}`,
      timestamp: new Date().toISOString()
    });
    await saveJobToKV(jobId, job, kvStore);
    console.error(`Failed to initialize session for job ${jobId}:`, error);
    return;
  }

  async function runPollCycle() {
    const currentJob = await getJobFromKV(jobId, kvStore);
    if (!currentJob) return;

    currentJob.status = 'running';
    currentJob.lastUpdate = new Date().toISOString();
    await saveJobToKV(jobId, currentJob, kvStore);

    for (const date of dates) {
      const currentJob = await getJobFromKV(jobId, kvStore);
      if (!currentJob) break;

      const result = await pollForDate(jobId, finalVerificationNumber, csrfToken, date, gender);
      currentJob.totalRequests++;

      if (result.success) {
        const records = parseCertificateData(result.data);
        const currentJob = await getJobFromKV(jobId, kvStore);
        if (!currentJob) continue;
        
        if (searchName) {
          const matchingRecords = records.map(record => {
            const nameMatch = nameMatches(searchName, record.name);
            const fatherMatch = nameMatches(searchName, record.fathersName);
            const motherMatch = nameMatches(searchName, record.mothersName);
            
            const matches = [nameMatch, fatherMatch, motherMatch].filter(m => m.match);
            if (matches.length === 0) return null;
            
            const bestMatch = matches.reduce((best, current) => 
              current.score > best.score ? current : best
            );
            
            return {
              ...record,
              matchScore: bestMatch.score,
              matchedField: nameMatch.match ? 'name' : (fatherMatch.match ? 'fathersName' : 'mothersName'),
              matchedPart: bestMatch.matchedPart
            };
          }).filter(record => record !== null)
          .sort((a, b) => b.matchScore - a.matchScore)
          .filter(record => {
            const passes = record.matchScore >= 60;
            if (!passes) {
              console.log(`Filtered out low-score match: ${record.name} (score: ${record.matchScore})`);
            }
            return passes;
          });

          if (matchingRecords.length > 0) {
            matchingRecords.forEach(record => {
              record.date = date;
            });
            
            const foundEntry = {
              date,
              records: matchingRecords,
              totalRecordsOnDate: records.length
            };
            
            const existingIndex = currentJob.foundDates.findIndex(f => f.date === date);
            if (existingIndex >= 0) {
              const existing = currentJob.foundDates[existingIndex];
              const mergedRecords = [...existing.records, ...matchingRecords];
              const uniqueRecords = mergedRecords.filter((record, index, self) =>
                index === self.findIndex(r => r.name === record.name && r.date === record.date)
              );
              currentJob.foundDates[existingIndex] = {
                ...foundEntry,
                records: uniqueRecords
              };
            } else {
              currentJob.foundDates.push(foundEntry);
            }
            
            await saveJobToKV(jobId, currentJob, kvStore);
            console.log(`Found ${matchingRecords.length} matching record(s) for "${searchName}" on date ${date}`);
          }
        } else {
          records.forEach(record => {
            record.date = date;
            currentJob.allRecords.push(record);
          });
          
          if (currentJob.allRecords.length > 1000) {
            currentJob.allRecords = currentJob.allRecords.slice(-1000);
          }
          await saveJobToKV(jobId, currentJob, kvStore);
        }
      } else {
        if (result.needsReinit || (result.error && result.error.includes('419'))) {
          console.log(`CSRF token expired for job ${jobId}. Reinitializing session...`);
          try {
            const sessionData = await initializeSession(jobId, finalVerificationNumber);
            csrfToken = sessionData.csrfToken;
            
            if (sessionData.verificationNumber && !finalVerificationNumber) {
              finalVerificationNumber = sessionData.verificationNumber;
            }
            
            console.log(`Session reinitialized for job ${jobId}`);
            const retryResult = await pollForDate(jobId, finalVerificationNumber, csrfToken, date, gender);
            const retryJob = await getJobFromKV(jobId, kvStore);
            if (retryJob) {
              retryJob.totalRequests++;
              
              if (retryResult.success) {
                const records = parseCertificateData(retryResult.data);
                records.forEach(record => {
                  record.date = date;
                  retryJob.allRecords.push(record);
                });
                
                if (searchName) {
                  const matchingRecords = records.map(record => {
                    const nameMatch = nameMatches(searchName, record.name);
                    const fatherMatch = nameMatches(searchName, record.fathersName);
                    const motherMatch = nameMatches(searchName, record.mothersName);
                    const matches = [nameMatch, fatherMatch, motherMatch].filter(m => m.match);
                    if (matches.length === 0) return null;
                    const bestMatch = matches.reduce((best, current) => 
                      current.score > best.score ? current : best
                    );
                    return {
                      ...record,
                      matchScore: bestMatch.score,
                      matchedField: nameMatch.match ? 'name' : (fatherMatch.match ? 'fathersName' : 'mothersName'),
                      matchedPart: bestMatch.matchedPart
                    };
                  }).filter(record => record !== null && record.matchScore >= 60);
                  
                  if (matchingRecords.length > 0) {
                    matchingRecords.forEach(record => {
                      record.date = date;
                    });
                    const foundEntry = { date, records: matchingRecords };
                    const existingIndex = retryJob.foundDates.findIndex(f => f.date === date);
                    if (existingIndex >= 0) {
                      retryJob.foundDates[existingIndex] = foundEntry;
                    } else {
                      retryJob.foundDates.push(foundEntry);
                    }
                  }
                }
                await saveJobToKV(jobId, retryJob, kvStore);
                continue;
              }
            }
          } catch (reinitError) {
            console.error(`Failed to reinitialize session for job ${jobId}:`, reinitError);
          }
        }
        
        const errorJob = await getJobFromKV(jobId, kvStore);
        if (errorJob) {
          errorJob.errors.push({
            date,
            error: result.error,
            timestamp: new Date().toISOString()
          });
          await saveJobToKV(jobId, errorJob, kvStore);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const checkJob = await getJobFromKV(jobId, kvStore);
    if (checkJob && checkJob.status !== 'stopped') {
      setTimeout(runPollCycle, pollInterval);
    }
  }

  runPollCycle();
}

// Helper functions for KV storage
async function getJobFromKV(jobId, kvStore) {
  // Always check in-memory first (fastest)
  const memoryJob = activeJobs.get(jobId);
  if (memoryJob) {
    return memoryJob;
  }
  
  // Then check KV if available
  if (kvStore) {
    try {
      const jobData = await kvStore.get(`job:${jobId}`);
      if (jobData) {
        const job = JSON.parse(jobData);
        // Also restore to memory for faster access
        activeJobs.set(jobId, job);
        return job;
      }
    } catch (error) {
      console.error('Error reading job from KV:', error);
    }
  }
  
  return null;
}

async function saveJobToKV(jobId, job, kvStore) {
  // Also keep in memory for fast access
  activeJobs.set(jobId, job);
  
  if (kvStore) {
    try {
      await kvStore.put(`job:${jobId}`, JSON.stringify(job));
    } catch (error) {
      console.error('Error saving job to KV:', error);
    }
  }
}

async function deleteJobFromKV(jobId, kvStore) {
  activeJobs.delete(jobId);
  jobCookies.delete(jobId);
  
  if (kvStore) {
    try {
      await kvStore.delete(`job:${jobId}`);
    } catch (error) {
      console.error('Error deleting job from KV:', error);
    }
  }
}

async function getAllJobsFromKV(kvStore) {
  if (!kvStore) {
    // Fallback to in-memory
    return Array.from(activeJobs.entries());
  }
  try {
    // KV doesn't support list operations directly, so we'll use in-memory as primary
    // and sync from KV when needed. For now, we'll use a jobs index.
    const jobsIndex = await kvStore.get('jobs:index');
    const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];
    const jobs = [];
    
    for (const jobId of jobIds) {
      const job = await getJobFromKV(jobId, kvStore);
      if (job) {
        jobs.push([jobId, job]);
      }
    }
    
    return jobs;
  } catch (error) {
    console.error('Error reading jobs from KV:', error);
    return Array.from(activeJobs.entries());
  }
}

async function addJobToIndex(jobId, kvStore) {
  if (!kvStore) return;
  try {
    const jobsIndex = await kvStore.get('jobs:index');
    const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];
    if (!jobIds.includes(jobId)) {
      jobIds.push(jobId);
      await kvStore.put('jobs:index', JSON.stringify(jobIds));
    }
  } catch (error) {
    console.error('Error updating jobs index:', error);
  }
}

async function removeJobFromIndex(jobId, kvStore) {
  if (!kvStore) return;
  try {
    const jobsIndex = await kvStore.get('jobs:index');
    const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];
    const filtered = jobIds.filter(id => id !== jobId);
    await kvStore.put('jobs:index', JSON.stringify(filtered));
  } catch (error) {
    console.error('Error updating jobs index:', error);
  }
}

// CORS headers helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// Main worker handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const kvStore = env.JOBS_STORE; // KV namespace from wrangler.toml

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    // Health check
    if (path === '/api/health' && method === 'GET') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        timestamp: new Date().toISOString() 
      }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // Start polling
    if (path === '/api/start-polling' && method === 'POST') {
      try {
        const body = await request.json();
        const { 
          verificationNumber, 
          token,
          startDate, 
          endDate, 
          gender = 'male',
          searchName,
          intervalMinutes = 60 
        } = body;

        if (!startDate || !endDate) {
          return new Response(JSON.stringify({ 
            error: 'Missing required fields: startDate, endDate' 
          }), {
            status: 400,
            headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
          });
        }

        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const dates = getDatesInRange(startDate, endDate);
        
        jobCookies.set(jobId, {});
        
        const results = {
          jobId,
          searchName: searchName || null,
          foundDates: [],
          allRecords: [],
          status: 'initializing',
          startTime: new Date().toISOString(),
          lastUpdate: null,
          totalRequests: 0,
          errors: []
        };

        // Save to both memory and KV
        await saveJobToKV(jobId, results, kvStore);
        await addJobToIndex(jobId, kvStore);

        // Start polling job (will update KV as it progresses)
        startPollingJob(jobId, verificationNumber, token, dates, gender, searchName, intervalMinutes, kvStore);

        return new Response(JSON.stringify({ 
          jobId, 
          message: 'Polling started. Session will be initialized automatically.',
          totalDates: dates.length
        }), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error starting polling:', error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
    }

    // Get job status
    if (path.startsWith('/api/job/') && method === 'GET') {
      const jobId = path.split('/api/job/')[1]?.split('?')[0]?.split('/')[0];
      if (!jobId) {
        return new Response(JSON.stringify({ error: 'Job ID is required' }), {
          status: 400,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
      const job = await getJobFromKV(jobId, kvStore);
      
      if (!job) {
        return new Response(JSON.stringify({ error: 'Job not found' }), {
          status: 404,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
      
      return new Response(JSON.stringify(job), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // Stop polling
    if (path.startsWith('/api/job/') && method === 'DELETE') {
      const jobId = path.split('/api/job/')[1]?.split('?')[0]?.split('/')[0];
      if (!jobId) {
        return new Response(JSON.stringify({ error: 'Job ID is required' }), {
          status: 400,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
      
      const job = await getJobFromKV(jobId, kvStore);
      if (job) {
        job.status = 'stopped';
        await saveJobToKV(jobId, job, kvStore);
        await deleteJobFromKV(jobId, kvStore);
        await removeJobFromIndex(jobId, kvStore);
        return new Response(JSON.stringify({ message: 'Job stopped', jobId }), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      } else {
        return new Response(JSON.stringify({ error: 'Job not found' }), {
          status: 404,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
    }

    // List all jobs
    if (path === '/api/jobs' && method === 'GET') {
      const jobs = await getAllJobsFromKV(kvStore);
      const jobsList = jobs.map(([jobId, job]) => ({
        jobId,
        searchName: job.searchName,
        status: job.status,
        startTime: job.startTime,
        lastUpdate: job.lastUpdate,
        foundDatesCount: job.foundDates.length,
        totalRequests: job.totalRequests
      }));
      
      return new Response(JSON.stringify({ jobs: jobsList }), {
        headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
      });
    }

    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
};

