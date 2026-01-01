// Durable Object class for managing stateful polling jobs
import { parseHTML } from 'linkedom';

export class JobDurableObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.jobId = null;
    this.job = null;
    this.cookies = {};
    this.csrfToken = null;
    this.verificationNumber = null;
    this.dates = [];
    this.gender = 'male';
    this.searchName = null;
    this.intervalMinutes = 60;
    this.currentDateIndex = 0;
    this.isRunning = false;
    this.alarmScheduled = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: this.corsHeaders() });
    }

    // Initialize job
    if (path === '/init' && method === 'POST') {
      return this.handleInit(request);
    }

    // Get job status
    if (path === '/status' && method === 'GET') {
      return this.handleGetStatus();
    }

    // Stop job
    if (path === '/stop' && method === 'POST') {
      return this.handleStop();
    }

    // Start/continue polling
    if (path === '/poll' && method === 'POST') {
      return this.handlePoll();
    }

    // Alarm handler (called by Cloudflare when alarm fires)
    if (path === '/alarm' && method === 'POST') {
      return this.handleAlarm();
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };
  }

  async handleInit(request) {
    try {
      const body = await request.json();
      const {
        jobId,
        verificationNumber,
        token,
        dates,
        gender = 'male',
        searchName,
        intervalMinutes = 60
      } = body;

      this.jobId = jobId;
      this.dates = dates;
      this.gender = gender;
      this.searchName = searchName;
      this.intervalMinutes = intervalMinutes;
      this.csrfToken = token;
      this.verificationNumber = verificationNumber;
      this.currentDateIndex = 0;
      this.cookies = {};

      // Load existing job state from storage
      const stored = await this.state.storage.get('job');
      if (stored) {
        this.job = stored;
      } else {
        this.job = {
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
      }

      // Load cookies from storage
      const storedCookies = await this.state.storage.get('cookies');
      if (storedCookies) {
        this.cookies = storedCookies;
      }

      // Save initial state
      await this.saveState();

      // Start initialization
      this.isRunning = true;
      this.job.status = 'initializing';
      this.job.lastUpdate = new Date().toISOString();
      await this.saveState();

      // Initialize session
      try {
        console.log(`Initializing session for job ${this.jobId}...`);
        const sessionData = await this.initializeSession();

        if (!this.csrfToken) {
          this.csrfToken = sessionData.csrfToken;
          console.log(`CSRF token extracted from page`);
        }

        if (!this.verificationNumber && sessionData.verificationNumber) {
          this.verificationNumber = sessionData.verificationNumber;
          console.log(`Using extracted verification number: ${this.verificationNumber}`);
        }

        if (!this.verificationNumber) {
          throw new Error('Verification number is required. Please provide it or ensure it can be extracted from the page.');
        }

        if (!this.csrfToken) {
          throw new Error('CSRF token is required. Could not extract from page.');
        }

        console.log(`Session initialized. Ready to start polling for job ${this.jobId}`);
        this.job.status = 'running';
        await this.saveState();

        // Start first poll cycle
        await this.runPollCycle();

        return new Response(JSON.stringify({
          success: true,
          message: 'Job initialized and polling started',
          jobId: this.jobId
        }), {
          headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
        });
      } catch (error) {
        this.job.status = 'error';
        this.job.errors.push({
          date: 'initialization',
          error: `Failed to initialize session: ${error.message}`,
          timestamp: new Date().toISOString()
        });
        await this.saveState();
        console.error(`Failed to initialize session for job ${this.jobId}:`, error);
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 500,
          headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
    } catch (error) {
      console.error('Error in handleInit:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
      });
    }
  }

  async handleGetStatus() {
    await this.loadState();
    return new Response(JSON.stringify(this.job || { error: 'Job not initialized' }), {
      headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  async handleStop() {
    this.isRunning = false;
    if (this.job) {
      this.job.status = 'stopped';
      await this.saveState();
    }
    // Clear any scheduled alarms
    try {
      await this.state.storage.deleteAlarm();
    } catch (e) {
      // Ignore if no alarm exists
    }
    return new Response(JSON.stringify({ message: 'Job stopped', jobId: this.jobId }), {
      headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  async handlePoll() {
    if (!this.isRunning && this.job && this.job.status !== 'stopped') {
      this.isRunning = true;
      await this.runPollCycle();
    }
    return new Response(JSON.stringify({ message: 'Poll cycle triggered' }), {
      headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  async handleAlarm() {
    // Alarm fired - continue polling cycle
    if (this.isRunning && this.job && this.job.status !== 'stopped') {
      await this.runPollCycle();
    }
    return new Response(JSON.stringify({ message: 'Alarm handled' }), {
      headers: { ...this.corsHeaders(), 'Content-Type': 'application/json' }
    });
  }

  async loadState() {
    const stored = await this.state.storage.get('job');
    if (stored) {
      this.job = stored;
    }
    const storedCookies = await this.state.storage.get('cookies');
    if (storedCookies) {
      this.cookies = storedCookies;
    }
    const storedConfig = await this.state.storage.get('config');
    if (storedConfig) {
      this.dates = storedConfig.dates || [];
      this.gender = storedConfig.gender || 'male';
      this.searchName = storedConfig.searchName || null;
      this.intervalMinutes = storedConfig.intervalMinutes || 60;
      this.csrfToken = storedConfig.csrfToken || null;
      this.verificationNumber = storedConfig.verificationNumber || null;
      this.currentDateIndex = storedConfig.currentDateIndex || 0;
    }
  }

  async saveState() {
    if (this.job) {
      await this.state.storage.put('job', this.job);
    }
    await this.state.storage.put('cookies', this.cookies);
    await this.state.storage.put('config', {
      dates: this.dates,
      gender: this.gender,
      searchName: this.searchName,
      intervalMinutes: this.intervalMinutes,
      csrfToken: this.csrfToken,
      verificationNumber: this.verificationNumber,
      currentDateIndex: this.currentDateIndex
    });
  }

  async runPollCycle() {
    if (!this.job || this.job.status === 'stopped') {
      this.isRunning = false;
      return;
    }

    await this.loadState();

    this.job.status = 'running';
    this.job.lastUpdate = new Date().toISOString();
    await this.saveState();

    // Process all dates in the current cycle
    for (let i = this.currentDateIndex; i < this.dates.length; i++) {
      if (!this.isRunning || this.job.status === 'stopped') break;

      const date = this.dates[i];
      this.currentDateIndex = i;

      const result = await this.pollForDate(date);
      this.job.totalRequests++;

      if (result.success) {
        const records = this.parseCertificateData(result.data);

        if (this.searchName) {
          const matchingRecords = records.map(record => {
            const nameMatch = this.nameMatches(this.searchName, record.name);
            const fatherMatch = this.nameMatches(this.searchName, record.fathersName);
            const motherMatch = this.nameMatches(this.searchName, record.mothersName);

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

            const existingIndex = this.job.foundDates.findIndex(f => f.date === date);
            if (existingIndex >= 0) {
              const existing = this.job.foundDates[existingIndex];
              const mergedRecords = [...existing.records, ...matchingRecords];
              const uniqueRecords = mergedRecords.filter((record, index, self) =>
                index === self.findIndex(r => r.name === record.name && r.date === record.date)
              );
              this.job.foundDates[existingIndex] = {
                ...foundEntry,
                records: uniqueRecords
              };
            } else {
              this.job.foundDates.push(foundEntry);
            }

            await this.saveState();
            console.log(`Found ${matchingRecords.length} matching record(s) for "${this.searchName}" on date ${date}`);
          }
        } else {
          records.forEach(record => {
            record.date = date;
            this.job.allRecords.push(record);
          });

          if (this.job.allRecords.length > 1000) {
            this.job.allRecords = this.job.allRecords.slice(-1000);
          }
          await this.saveState();
        }
      } else {
        // Check if we need to reinitialize session
        if (result.needsReinit || (result.error && result.error.includes('419'))) {
          console.log(`CSRF token expired for job ${this.jobId}. Reinitializing session...`);
          try {
            const sessionData = await this.initializeSession();
            this.csrfToken = sessionData.csrfToken;

            if (sessionData.verificationNumber && !this.verificationNumber) {
              this.verificationNumber = sessionData.verificationNumber;
            }

            console.log(`Session reinitialized for job ${this.jobId}`);
            const retryResult = await this.pollForDate(date);
            this.job.totalRequests++;

            if (retryResult.success) {
              const records = this.parseCertificateData(retryResult.data);
              
              if (this.searchName) {
                const matchingRecords = records.map(record => {
                  const nameMatch = this.nameMatches(this.searchName, record.name);
                  const fatherMatch = this.nameMatches(this.searchName, record.fathersName);
                  const motherMatch = this.nameMatches(this.searchName, record.mothersName);
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
                  const foundEntry = { date, records: matchingRecords, totalRecordsOnDate: records.length };
                  const existingIndex = this.job.foundDates.findIndex(f => f.date === date);
                  if (existingIndex >= 0) {
                    // Merge records if date already exists
                    const existing = this.job.foundDates[existingIndex];
                    const mergedRecords = [...existing.records, ...matchingRecords];
                    // Remove duplicates based on name and date
                    const uniqueRecords = mergedRecords.filter((record, index, self) =>
                      index === self.findIndex(r => r.name === record.name && r.date === record.date)
                    );
                    this.job.foundDates[existingIndex] = {
                      ...foundEntry,
                      records: uniqueRecords
                    };
                  } else {
                    this.job.foundDates.push(foundEntry);
                  }
                }
              } else {
                records.forEach(record => {
                  record.date = date;
                  this.job.allRecords.push(record);
                });
                if (this.job.allRecords.length > 1000) {
                  this.job.allRecords = this.job.allRecords.slice(-1000);
                }
              }
              await this.saveState();
              continue; // Skip error logging for retry success
            }
          } catch (reinitError) {
            console.error(`Failed to reinitialize session for job ${this.jobId}:`, reinitError);
          }
        }

        this.job.errors.push({
          date,
          error: result.error,
          timestamp: new Date().toISOString()
        });
        await this.saveState();
      }

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Reset for next cycle
    this.currentDateIndex = 0;

    // Schedule next poll cycle using alarm
    if (this.isRunning && this.job && this.job.status !== 'stopped') {
      const pollInterval = this.intervalMinutes * 60 * 1000; // Convert to milliseconds
      const alarmTime = Date.now() + pollInterval;
      try {
        await this.state.storage.setAlarm(alarmTime);
        this.alarmScheduled = true;
        console.log(`Scheduled next poll cycle for job ${this.jobId} in ${this.intervalMinutes} minutes`);
      } catch (error) {
        console.error(`Failed to schedule alarm for job ${this.jobId}:`, error);
      }
    } else {
      this.isRunning = false;
    }
  }

  async alarm() {
    // This is called when the alarm fires
    if (this.isRunning && this.job && this.job.status !== 'stopped') {
      await this.runPollCycle();
    }
  }

  parseCookies(setCookieHeader) {
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

  formatCookies(cookies) {
    return Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  parseCertificateData(htmlData) {
    const { document } = parseHTML(htmlData);
    const records = [];

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

  normalizeName(name) {
    if (!name) return '';
    return name.toLowerCase()
      .replace(/\./g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  nameMatches(searchName, recordName) {
    if (!searchName || !recordName) return { match: false, score: 0, matchedPart: '' };

    const cleanSearch = searchName.trim();
    const cleanRecord = recordName.trim();

    const normalizedSearch = this.normalizeName(cleanSearch);
    const normalizedRecord = this.normalizeName(cleanRecord);

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

  async initializeSession() {
    try {
      const response = await fetch('http://27.100.26.138/death-certificate', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': this.formatCookies(this.cookies)
        }
      });

      // Check if response is successful
      if (!response.ok) {
        throw new Error(`Failed to fetch page: ${response.status} ${response.statusText}`);
      }

      const setCookieHeader = response.headers.get('Set-Cookie');
      if (setCookieHeader) {
        const newCookies = this.parseCookies(setCookieHeader);
        Object.assign(this.cookies, newCookies);
        await this.saveState();
      }

      const htmlData = await response.text();
      
      // Check if we got HTML content
      if (!htmlData || htmlData.length === 0) {
        throw new Error('Received empty response from server');
      }

      // Check if response is HTML (basic check)
      if (!htmlData.includes('<html') && !htmlData.includes('<!DOCTYPE')) {
        console.warn('Response might not be HTML. First 200 chars:', htmlData.substring(0, 200));
      }

      const { document } = parseHTML(htmlData);

      let csrfToken = null;
      let extractedVerificationNumber = null;

      // Try multiple methods to find CSRF token
      const metaToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
      if (metaToken) {
        csrfToken = metaToken;
        console.log('Found CSRF token in meta tag');
      } else {
        const formToken = document.querySelector('input[name="_token"]')?.getAttribute('value');
        if (formToken) {
          csrfToken = formToken;
          console.log('Found CSRF token in form input');
        } else {
          // Try to find in all meta tags
          const allMetaTags = document.querySelectorAll('meta');
          for (const meta of allMetaTags) {
            const name = meta.getAttribute('name');
            if (name && (name.toLowerCase().includes('csrf') || name.toLowerCase().includes('token'))) {
              csrfToken = meta.getAttribute('content');
              if (csrfToken) {
                console.log(`Found CSRF token in meta tag: ${name}`);
                break;
              }
            }
          }
          
          // Try to find in all hidden inputs
          if (!csrfToken) {
            const allInputs = document.querySelectorAll('input[type="hidden"]');
            for (const input of allInputs) {
              const name = input.getAttribute('name');
              if (name && (name.toLowerCase().includes('csrf') || name.toLowerCase().includes('token') || name === '_token')) {
                csrfToken = input.getAttribute('value');
                if (csrfToken) {
                  console.log(`Found CSRF token in hidden input: ${name}`);
                  break;
                }
              }
            }
          }
          
          // Fallback: try to get from cookies
          if (!csrfToken) {
            const xsrfCookie = this.cookies['XSRF-TOKEN'] || this.cookies['xsrf-token'] || this.cookies['csrf-token'];
            if (xsrfCookie) {
              csrfToken = xsrfCookie;
              console.log('Found CSRF token in cookie');
            }
          }
        }
      }

      if (!csrfToken) {
        // Log HTML snippet for debugging
        const htmlSnippet = htmlData.substring(0, 1000);
        console.error('HTML snippet (first 1000 chars):', htmlSnippet);
        throw new Error('Could not extract CSRF token from page. Check console logs for HTML content.');
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

      const finalVerificationNumber = this.verificationNumber || extractedVerificationNumber;

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
      console.error(`Error initializing session for job ${this.jobId}:`, error.message);
      throw error;
    }
  }

  async pollForDate(date) {
    try {
      if (!this.cookies || Object.keys(this.cookies).length === 0) {
        return {
          success: false,
          error: 'Session not initialized. Cookies not found.',
          date
        };
      }

      const params = new URLSearchParams({
        dod: date,
        gender: this.gender,
        verification_number: this.verificationNumber,
        _token: this.csrfToken
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
          'Cookie': this.formatCookies(this.cookies)
        },
        body: params.toString()
      });

      const setCookieHeader = response.headers.get('Set-Cookie');
      if (setCookieHeader) {
        const newCookies = this.parseCookies(setCookieHeader);
        Object.assign(this.cookies, newCookies);
        await this.saveState();
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
}

