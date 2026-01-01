const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Store active polling jobs
const activeJobs = new Map();

// Store cookie jars for each job (to maintain separate sessions)
const jobCookieJars = new Map();

// Helper function to parse HTML response and extract names and dates
function parseCertificateData(htmlData) {
  const $ = cheerio.load(htmlData);
  const records = [];
  
  // Try multiple selectors to ensure we get all rows
  // The table might have different structures or be inside different containers
  let rows = $('#death-table tbody tr');
  
  // If no rows found, try alternative selectors
  if (rows.length === 0) {
    rows = $('table tbody tr'); // Try any table
  }
  if (rows.length === 0) {
    rows = $('.table tbody tr'); // Try table with class
  }
  if (rows.length === 0) {
    rows = $('tbody tr'); // Try any tbody
  }
  
  rows.each((index, element) => {
    const $row = $(element);
    const name = $row.find('td:nth-child(2)').text().trim();
    const gender = $row.find('td:nth-child(3)').text().trim();
    const dateOfDeath = $row.find('td:nth-child(4)').text().trim();
    const fathersName = $row.find('td:nth-child(5)').text().trim();
    const mothersName = $row.find('td:nth-child(6)').text().trim();
    
    // Only add if name exists and is not a placeholder
    if (name && name !== '.......' && name !== '...' && name.length > 0) {
      records.push({
        name,
        gender,
        dateOfDeath,
        fathersName,
        mothersName
      });
    }
  });
  
  console.log(`Parsed ${records.length} records from HTML`);
  return records;
}

// Helper function to normalize names for matching (removes dots, spaces, converts to lowercase)
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\./g, '')  // Remove dots
    .replace(/\s+/g, ' ') // Normalize multiple spaces to single space
    .trim();
}

// Helper function to check if name matches with match quality score
// Returns { match: boolean, score: number, matchedPart: string }
function nameMatches(searchName, recordName) {
  if (!searchName || !recordName) return { match: false, score: 0, matchedPart: '' };
  
  // Trim and clean both names
  const cleanSearch = searchName.trim();
  const cleanRecord = recordName.trim();
  
  const normalizedSearch = normalizeName(cleanSearch);
  const normalizedRecord = normalizeName(cleanRecord);
  
  // Exact match after normalization - only 100% matches
  if (normalizedSearch === normalizedRecord) {
    return { match: true, score: 100, matchedPart: recordName };
  }
  
  // For non-exact matches, check if main name part matches
  // This allows "kowsalya" to match "D.KOWSALYA" because main part "kowsalya" matches
  const searchParts = normalizedSearch.split(/[\s.]+/).filter(w => w.length > 0);
  const recordParts = normalizedRecord.split(/[\s.]+/).filter(w => w.length > 0);
  
  // Find the longest part in search (this is usually the main name like "KOWSALYA")
  const longestSearchPart = searchParts.reduce((longest, part) => 
    part.length > longest.length ? part : longest, '');
  
  // The longest search part must be at least 3 characters to avoid single-letter matches
  if (longestSearchPart.length < 3) {
    return { match: false, score: 0, matchedPart: '' };
  }
  
  // Check if the main name part (longest search part) matches any record part
  // This allows "kowsalya" to match "D.KOWSALYA" because "kowsalya" matches "kowsalya" in the record
  const hasMainMatch = recordParts.some(recordPart => 
    recordPart.includes(longestSearchPart) || longestSearchPart.includes(recordPart)
  );
  
  if (!hasMainMatch) {
    return { match: false, score: 0, matchedPart: '' };
  }
  
  // If main part matches, calculate score
  // Case 1: Search is contained in record (e.g., "kowsalya" in "dkowsalya")
  if (normalizedRecord.includes(normalizedSearch)) {
    const score = Math.min(100, (normalizedSearch.length / normalizedRecord.length) * 100);
    // Main part matched, so this is valid - return if score is reasonable
    if (score >= 50) {
      return { match: true, score: Math.min(score, 100), matchedPart: recordName };
    }
  }
  
  // Case 2: Main part matches but search is not fully contained
  // This handles cases like searching "kowsalya" matching "D.KOWSALYA"
  if (longestSearchPart.length >= 4) {
    // Main name part is substantial, so if it matches, return a good score
    const mainPartMatchLength = recordParts
      .filter(rp => rp.includes(longestSearchPart) || longestSearchPart.includes(rp))
      .reduce((max, rp) => Math.max(max, rp.length), 0);
    
    if (mainPartMatchLength >= longestSearchPart.length) {
      // Calculate score based on how much of the main part matches
      const score = Math.min(100, (longestSearchPart.length / Math.max(normalizedRecord.length, longestSearchPart.length)) * 100);
      // Main part is substantial (at least 4 chars) and matches well
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
    const cookieJar = jobCookieJars.get(jobId);
    if (!cookieJar) {
      throw new Error('Cookie jar not found for job');
    }

    // Create axios instance with cookie support for this job
    const axiosWithCookies = wrapper(axios.create({ 
      jar: cookieJar,
      withCredentials: true 
    }));

    // Step 1: GET the actual website page (death-certificate) to get initial cookies, CSRF token, and verification number
    const getResponse = await axiosWithCookies.get('http://27.100.26.138/death-certificate', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 30000
    });

    // Extract CSRF token and verification number from the HTML page
    const $ = cheerio.load(getResponse.data);
    let csrfToken = null;
    let extractedVerificationNumber = null;
    
    // Try to find token in meta tag
    const metaToken = $('meta[name="csrf-token"]').attr('content');
    if (metaToken) {
      csrfToken = metaToken;
    } else {
      // Try to find token in form input
      const formToken = $('input[name="_token"]').attr('value');
      if (formToken) {
        csrfToken = formToken;
      } else {
        // Fallback: try to get from cookies
        const cookies = cookieJar.getCookiesSync('http://27.100.26.138');
        const xsrfCookie = cookies.find(c => c.key === 'XSRF-TOKEN');
        if (xsrfCookie) {
          csrfToken = xsrfCookie.value;
        }
      }
    }

    if (!csrfToken) {
      throw new Error('Could not extract CSRF token from page');
    }

    // Extract verification number (CAPTCHA) from the page
    // It's displayed in a span with class "captcha-number" or "input-group-text captcha-number"
    extractedVerificationNumber = $('.captcha-number').text().trim() || 
                                  $('span.input-group-text.captcha-number').text().trim() ||
                                  $('.input-group-text:contains("567227")').text().trim();
    
    // If we couldn't find it in those selectors, try to find the disabled input's value or nearby text
    if (!extractedVerificationNumber) {
      const captchaInput = $('input[name="verification_number"]');
      if (captchaInput.length) {
        // Check if there's a sibling span or next element with the number
        extractedVerificationNumber = captchaInput.siblings('.captcha-number').text().trim() ||
                                     captchaInput.closest('.input-group').find('.captcha-number').text().trim();
      }
    }

    // Use provided verification number if available, otherwise use extracted one
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

// API endpoint to start polling
app.post('/api/start-polling', async (req, res) => {
  try {
    const { 
      verificationNumber, 
      token, // Optional - will be auto-fetched if not provided
      startDate, 
      endDate, 
      gender = 'male',
      searchName,
      intervalMinutes = 60 
    } = req.body;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        error: 'Missing required fields: startDate, endDate' 
      });
    }
    
    // Verification number is optional - will be extracted from page if not provided
    if (!verificationNumber) {
      console.log('Verification number not provided. Will attempt to extract from page.');
    }

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const dates = getDatesInRange(startDate, endDate);
    
    // Create a cookie jar for this job
    const cookieJar = new CookieJar();
    jobCookieJars.set(jobId, cookieJar);
    
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

    // Start polling in background (will initialize session automatically)
    startPollingJob(jobId, verificationNumber, token, dates, gender, searchName, intervalMinutes);

    res.json({ 
      jobId, 
      message: 'Polling started. Session will be initialized automatically.',
      totalDates: dates.length
    });
  } catch (error) {
    console.error('Error starting polling:', error);
    res.status(500).json({ error: error.message });
  }
});

// Function to poll API for a specific date
async function pollForDate(jobId, verificationNumber, csrfToken, date, gender) {
  try {
    const cookieJar = jobCookieJars.get(jobId);
    if (!cookieJar) {
      return {
        success: false,
        error: 'Session not initialized. Cookie jar not found.',
        date
      };
    }

    // Create axios instance with cookie support for this job
    const axiosWithCookies = wrapper(axios.create({ 
      jar: cookieJar,
      withCredentials: true 
    }));

    const response = await axiosWithCookies.post(
      'http://27.100.26.138/death/fetch-certificates',
      new URLSearchParams({
        dod: date,
        gender: gender,
        verification_number: verificationNumber,
        _token: csrfToken
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
              'Referer': 'http://27.100.26.138/death-certificate'
        },
        timeout: 30000
      }
    );

    if (response.data && response.data.status && response.data.data) {
      return {
        success: true,
        data: response.data.data,
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
    // Check if it's a 419 error (CSRF token expired)
    if (error.response && error.response.status === 419) {
      return {
        success: false,
        error: 'CSRF token expired. Session needs to be reinitialized.',
        date,
        needsReinit: true
      };
    }
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

  const pollInterval = intervalMinutes * 60 * 1000; // Convert to milliseconds
  let csrfToken = providedToken; // Use provided token if available, otherwise will be fetched
  let finalVerificationNumber = verificationNumber; // Use provided verification number, or extract from page

  // Initialize session and get CSRF token
  try {
    job.status = 'initializing';
    job.lastUpdate = new Date().toISOString();
    
    // Always initialize session to get cookies and extract verification number if needed
    // Even if token is provided, we need to initialize session for cookies
    console.log(`Initializing session for job ${jobId}...`);
    const sessionData = await initializeSession(jobId, verificationNumber);
    
    // Use extracted CSRF token if not provided
    if (!csrfToken) {
      csrfToken = sessionData.csrfToken;
      console.log(`CSRF token extracted from page`);
    }
    
    // Use extracted verification number if user didn't provide one
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
    if (!activeJobs.has(jobId)) return; // Job was stopped

    job.status = 'running';
    job.lastUpdate = new Date().toISOString();

    // Check if we need to reinitialize session (if token expired)
    let needsReinit = false;

    for (const date of dates) {
      if (!activeJobs.has(jobId)) break; // Check if job still exists

      const result = await pollForDate(jobId, finalVerificationNumber, csrfToken, date, gender);
      job.totalRequests++;

      if (result.success) {
        needsReinit = false; // Reset flag on success
        const records = parseCertificateData(result.data);
        
        // Check for search name if provided
        if (searchName) {
          const matchingRecords = records.map(record => {
            const nameMatch = nameMatches(searchName, record.name);
            const fatherMatch = nameMatches(searchName, record.fathersName);
            const motherMatch = nameMatches(searchName, record.mothersName);
            
            // Get the best match (highest score)
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
          // Sort by match score (highest first)
          .sort((a, b) => b.matchScore - a.matchScore)
          // Show matches with score >= 60 (allows main name part matches)
          // This allows "kowsalya" to match "D.KOWSALYA" when main part matches
          .filter(record => {
            const passes = record.matchScore >= 60;
            if (!passes) {
              console.log(`Filtered out low-score match: ${record.name} (score: ${record.matchScore})`);
            }
            return passes;
          });

          if (matchingRecords.length > 0) {
            // Add date to each matching record
            matchingRecords.forEach(record => {
              record.date = date;
            });
            
            const foundEntry = {
              date,
              records: matchingRecords,
              totalRecordsOnDate: records.length // Track total records for this date
            };
            
            // Check if date already exists in foundDates
            const existingIndex = job.foundDates.findIndex(f => f.date === date);
            if (existingIndex >= 0) {
              // Merge records if date already exists
              const existing = job.foundDates[existingIndex];
              const mergedRecords = [...existing.records, ...matchingRecords];
              // Remove duplicates based on name and date
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
          
          // Only store matching records when searching (to save memory)
          // Don't store all records when searching - only matches
        } else {
          // If no search name, store all records (but limit to recent ones to avoid memory issues)
          records.forEach(record => {
            record.date = date;
            job.allRecords.push(record);
          });
          
          // Limit allRecords to last 1000 entries to prevent memory issues
          if (job.allRecords.length > 1000) {
            job.allRecords = job.allRecords.slice(-1000);
          }
        }
      } else {
        // Check if we need to reinitialize session
        if (result.needsReinit || (result.error && result.error.includes('419'))) {
          needsReinit = true;
          console.log(`CSRF token expired for job ${jobId}. Reinitializing session...`);
          try {
            // Reinitialize with verification number to validate session again
            const sessionData = await initializeSession(jobId, finalVerificationNumber);
            csrfToken = sessionData.csrfToken;
            
            // Update verification number if extracted
            if (sessionData.verificationNumber && !finalVerificationNumber) {
              finalVerificationNumber = sessionData.verificationNumber;
            }
            
            console.log(`Session reinitialized for job ${jobId}`);
            // Retry the failed request
            const retryResult = await pollForDate(jobId, finalVerificationNumber, csrfToken, date, gender);
            job.totalRequests++;
            
            if (retryResult.success) {
              const records = parseCertificateData(retryResult.data);
              records.forEach(record => {
                record.date = date;
                job.allRecords.push(record);
              });
              
              if (searchName) {
                const matchingRecords = records.filter(record => 
                  nameMatches(searchName, record.name) ||
                  nameMatches(searchName, record.fathersName) ||
                  nameMatches(searchName, record.mothersName)
                );
                
                if (matchingRecords.length > 0) {
                  const foundEntry = { date, records: matchingRecords };
                  const existingIndex = job.foundDates.findIndex(f => f.date === date);
                  if (existingIndex >= 0) {
                    job.foundDates[existingIndex] = foundEntry;
                  } else {
                    job.foundDates.push(foundEntry);
                  }
                }
              }
              continue; // Skip error logging for retry success
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

      // Small delay between requests to avoid overwhelming the API
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Schedule next poll cycle
    if (activeJobs.has(jobId)) {
      setTimeout(runPollCycle, pollInterval);
    }
  }

  // Start first cycle immediately
  runPollCycle();
}

// API endpoint to get job status
app.get('/api/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = activeJobs.get(jobId);
  
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  
  res.json(job);
});

// API endpoint to stop polling
app.delete('/api/job/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  if (activeJobs.has(jobId)) {
    const job = activeJobs.get(jobId);
    job.status = 'stopped';
    activeJobs.delete(jobId);
    jobCookieJars.delete(jobId); // Clean up cookie jar
    res.json({ message: 'Job stopped', jobId });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

// API endpoint to list all jobs
app.get('/api/jobs', (req, res) => {
  const jobs = Array.from(activeJobs.entries()).map(([jobId, job]) => ({
    jobId,
    searchName: job.searchName,
    status: job.status,
    startTime: job.startTime,
    lastUpdate: job.lastUpdate,
    foundDatesCount: job.foundDates.length,
    totalRequests: job.totalRequests
  }));
  
  res.json({ jobs });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

