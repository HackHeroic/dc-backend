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
async function startPollingJob(jobId, verificationNumber, providedToken, dates, gender, searchName, intervalMinutes) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  const pollInterval = intervalMinutes * 60 * 1000;
  let csrfToken = providedToken;
  let finalVerificationNumber = verificationNumber;

  try {
    job.status = 'initializing';
    job.lastUpdate = new Date().toISOString();
    
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
  } catch (error) {
    job.status = 'error';
    job.errors.push({
      date: 'initialization',
      error: `Failed to initialize session: ${error.message}`,
      timestamp: new Date().toISOString()
    });
    console.error(`Failed to initialize session for job ${jobId}:`, error);
    return;
  }

  async function runPollCycle() {
    if (!activeJobs.has(jobId)) return;

    job.status = 'running';
    job.lastUpdate = new Date().toISOString();

    for (const date of dates) {
      if (!activeJobs.has(jobId)) break;

      const result = await pollForDate(jobId, finalVerificationNumber, csrfToken, date, gender);
      job.totalRequests++;

      if (result.success) {
        const records = parseCertificateData(result.data);
        
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
            
            const existingIndex = job.foundDates.findIndex(f => f.date === date);
            if (existingIndex >= 0) {
              const existing = job.foundDates[existingIndex];
              const mergedRecords = [...existing.records, ...matchingRecords];
              const uniqueRecords = mergedRecords.filter((record, index, self) =>
                index === self.findIndex(r => r.name === record.name && r.date === record.date)
              );
              job.foundDates[existingIndex] = {
                ...foundEntry,
                records: uniqueRecords
              };
            } else {
              job.foundDates.push(foundEntry);
            }
            
            console.log(`Found ${matchingRecords.length} matching record(s) for "${searchName}" on date ${date}`);
          }
        } else {
          records.forEach(record => {
            record.date = date;
            job.allRecords.push(record);
          });
          
          if (job.allRecords.length > 1000) {
            job.allRecords = job.allRecords.slice(-1000);
          }
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
            job.totalRequests++;
            
            if (retryResult.success) {
              const records = parseCertificateData(retryResult.data);
              records.forEach(record => {
                record.date = date;
                job.allRecords.push(record);
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
                  const existingIndex = job.foundDates.findIndex(f => f.date === date);
                  if (existingIndex >= 0) {
                    job.foundDates[existingIndex] = foundEntry;
                  } else {
                    job.foundDates.push(foundEntry);
                  }
                }
              }
              continue;
            }
          } catch (reinitError) {
            console.error(`Failed to reinitialize session for job ${jobId}:`, reinitError);
          }
        }
        
        job.errors.push({
          date,
          error: result.error,
          timestamp: new Date().toISOString()
        });
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    if (activeJobs.has(jobId)) {
      setTimeout(runPollCycle, pollInterval);
    }
  }

  runPollCycle();
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

        activeJobs.set(jobId, results);

        startPollingJob(jobId, verificationNumber, token, dates, gender, searchName, intervalMinutes);

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
      const jobId = path.split('/api/job/')[1];
      const job = activeJobs.get(jobId);
      
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
      const jobId = path.split('/api/job/')[1];
      
      if (activeJobs.has(jobId)) {
        const job = activeJobs.get(jobId);
        job.status = 'stopped';
        activeJobs.delete(jobId);
        jobCookies.delete(jobId);
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
      const jobs = Array.from(activeJobs.entries()).map(([jobId, job]) => ({
        jobId,
        searchName: job.searchName,
        status: job.status,
        startTime: job.startTime,
        lastUpdate: job.lastUpdate,
        foundDatesCount: job.foundDates.length,
        totalRequests: job.totalRequests
      }));
      
      return new Response(JSON.stringify({ jobs }), {
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

