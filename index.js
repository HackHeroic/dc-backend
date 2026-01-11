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

// Helper function to parse CRSTN website HTML response
function parseCRSTNCertificateData(htmlData) {
  const $ = cheerio.load(htmlData);
  const records = [];
  
  // CRSTN website uses a different table structure
  // Looking for table with class "bordered" or just any table with rows
  let rows = $('table.bordered tbody tr');
  
  if (rows.length === 0) {
    rows = $('table tbody tr');
  }
  
  rows.each((index, element) => {
    const $row = $(element);
    const cells = $row.find('td');
    
    // CRSTN table structure: S NO, REG NO, DECEASED NAME, SEX, DATE OF DEATH, FATHER NAME, MOTHER NAME, REGISTRATION DATE
    if (cells.length >= 8) {
      const regNo = $row.find('td:nth-child(2)').text().trim();
      const name = $row.find('td:nth-child(3)').text().trim();
      const gender = $row.find('td:nth-child(4)').text().trim();
      const dateOfDeath = $row.find('td:nth-child(5)').text().trim();
      const fathersName = $row.find('td:nth-child(6)').text().trim();
      const mothersName = $row.find('td:nth-child(7)').text().trim();
      const registrationDate = $row.find('td:nth-child(8)').text().trim();
      
      // Skip header row
      if (name && name !== 'DECEASED NAME' && name !== '.......' && name !== '...' && name.length > 0) {
        records.push({
          regNo,
          name,
          gender,
          dateOfDeath,
          fathersName,
          mothersName,
          registrationDate
        });
      }
    }
  });
  
  console.log(`Parsed ${records.length} records from CRSTN HTML`);
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
    if (score >= 30) {
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
      if (score >= 30) {
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

// Function to generate captcha using the same algorithm as DrawCaptcha() in the website
function generateCaptcha() {
  // DrawCaptcha() algorithm from the website:
  // var a = Math.ceil(Math.random() * 10) + '';
  // var b = Math.ceil(Math.random() * 10) + '';
  // var c = Math.ceil(Math.random() * 10) + '';
  // var d = Math.ceil(Math.random() * 10) + '';
  // var e = Math.ceil(Math.random() * 10) + '';
  // var f = Math.ceil(Math.random() * 10) + '';
  // var g = Math.ceil(Math.random() * 10) + '';
  // var code = a + '' + b + '' + '' + c + '' + d + '' + e + '' + f + '' + g;
  
  // Math.ceil(Math.random() * 10) gives 1-10, but for digits we want 0-9
  // However, looking at the actual captcha values (like 48114310, 2665347), they're 7 digits
  // So we'll use Math.floor(Math.random() * 10) to get 0-9, or keep Math.ceil for 1-10
  // Actually, Math.ceil(Math.random() * 10) can give 10, but that's fine - it's what the site does
  
  const a = Math.ceil(Math.random() * 10);
  const b = Math.ceil(Math.random() * 10);
  const c = Math.ceil(Math.random() * 10);
  const d = Math.ceil(Math.random() * 10);
  const e = Math.ceil(Math.random() * 10);
  const f = Math.ceil(Math.random() * 10);
  const g = Math.ceil(Math.random() * 10);
  
  // The original code concatenates: a + '' + b + '' + '' + c + '' + d + '' + e + '' + f + '' + g
  // The extra '' doesn't matter, it's just string concatenation
  // Result: 7 digits concatenated together
  const code = String(a) + String(b) + String(c) + String(d) + String(e) + String(f) + String(g);
  
  return code;
}

// Function to initialize CRSTN session and get OTP
async function initializeCRSTNSession(jobId, mobileNumber) {
  try {
    const cookieJar = jobCookieJars.get(jobId);
    if (!cookieJar) {
      throw new Error('Cookie jar not found for job');
    }

    const axiosWithCookies = wrapper(axios.create({ 
      jar: cookieJar,
      withCredentials: true 
    }));

    // Step 1: GET the DCert page to initialize session
    const getResponse = await axiosWithCookies.get('https://www.crstn.org/birth_death_tn/DCert', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 30000
    });

    // Step 2: Send OTP request
    const otpResponse = await axiosWithCookies.post(
      'https://www.crstn.org/birth_death_tn/PubSendOTP.jsp',
      new URLSearchParams({ mob: mobileNumber }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.crstn.org/birth_death_tn/DCert'
        },
        timeout: 30000
      }
    );

    // Extract OTP from response HTML
    // Response format: "Please Enter the <font size='+1' style='color:#0000FF'>11800</font> to proceed..."
    // Or error: "Invalid Mobile Number"
    const otpHtml = typeof otpResponse.data === 'string' ? otpResponse.data : String(otpResponse.data);
    
    // Log raw response for debugging
    console.log(`PubSendOTP Response (first 500 chars): ${otpHtml.substring(0, 500)}`);
    
    // Check for error messages first
    const lowerResponse = otpHtml.toLowerCase().trim();
    if (lowerResponse.includes('invalid mobile number') || 
        lowerResponse.includes('please check your mobile number') ||
        lowerResponse.includes('check your mobile number')) {
      throw new Error(`OTP request failed: Invalid Mobile Number. The mobile number ${mobileNumber} may not be registered or valid. Please use a valid 10-digit mobile number.`);
    }
    
    let otp = null;
    
    // Method 1: Use cheerio to find font tag with specific style attribute
    try {
      const $ = cheerio.load(otpHtml);
      // Try exact match: font with style containing color:#0000FF
      const fontTag = $("font[style*='color:#0000FF']").text().trim() ||
                     $("font[style*='color: #0000FF']").text().trim() ||
                     $("font[size='+1'][style*='color']").text().trim();
      
      if (fontTag && /^\d{4,6}$/.test(fontTag)) {
        otp = fontTag;
        console.log(`OTP extracted via cheerio font tag: ${otp}`);
      }
    } catch (e) {
      console.log('Cheerio parsing failed, trying regex methods');
    }
    
    // Method 2: Regex to find font tag with number (more specific)
    if (!otp) {
      // Match: <font size='+1' style='color:#0000FF'>11800</font>
      const fontRegex = /<font[^>]*size=['"]\+1['"][^>]*style=['"][^'"]*color:\s*#0000FF[^'"]*['"][^>]*>(\d{4,6})<\/font>/i;
      const match = otpHtml.match(fontRegex);
      if (match && match[1]) {
        otp = match[1];
        console.log(`OTP extracted via regex (specific): ${otp}`);
      }
    }
    
    // Method 3: More flexible font tag regex
    if (!otp) {
      const fontRegex2 = /<font[^>]*>(\d{4,6})<\/font>/i;
      const match2 = otpHtml.match(fontRegex2);
      if (match2 && match2[1]) {
        otp = match2[1];
        console.log(`OTP extracted via regex (flexible): ${otp}`);
      }
    }
    
    // Method 4: Find any 4-6 digit number in the response (last resort)
    if (!otp) {
      const numberMatch = otpHtml.match(/\b(\d{4,6})\b/);
      if (numberMatch && numberMatch[1]) {
        otp = numberMatch[1];
        console.log(`OTP extracted via regex (number match): ${otp}`);
      }
    }

    if (!otp) {
      // Log the full response for debugging
      console.error(`Failed to extract OTP. Full response: ${otpHtml}`);
      throw new Error(`Could not extract OTP from response. Response: ${otpHtml.substring(0, 200)}`);
    }

    console.log(`OTP successfully extracted: ${otp}`);

    // Step 3: Verify OTP
    const verifyResponse = await axiosWithCookies.post(
      'https://www.crstn.org/birth_death_tn/PubChkOTP.jsp',
      new URLSearchParams({ 
        mob: mobileNumber,
        otp: otp
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://www.crstn.org/birth_death_tn/DCert'
        },
        timeout: 30000
      }
    );

    // Check OTP verification response
    // Expected response: "Number Verified"
    // Error response: "Invalid Mobile" or similar
    const verifyResult = typeof verifyResponse.data === 'string' ? verifyResponse.data : String(verifyResponse.data);
    console.log(`PubChkOTP Response: ${verifyResult.trim()}`);
    
    const verifyResultLower = verifyResult.toLowerCase().trim();
    if (verifyResultLower.includes('invalid') || verifyResultLower === 'invalid mobile') {
      throw new Error(`OTP verification failed: ${verifyResult.trim()}. The OTP ${otp} may be incorrect or expired.`);
    }
    
    if (!verifyResultLower.includes('number verified') && verifyResultLower !== 'number verified') {
      console.warn(`Unexpected OTP verification response: ${verifyResult.trim()}. Continuing anyway...`);
    } else {
      console.log(`OTP verification successful: Number Verified`);
    }

    // Step 4: Get captcha from the page (need to fetch DCert page again after OTP verification)
    // Add a small delay to ensure the server has processed the OTP verification
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const captchaResponse = await axiosWithCookies.get('https://www.crstn.org/birth_death_tn/DCert', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.crstn.org/birth_death_tn/DCert'
      },
      timeout: 30000
    });

    // Extract captcha - it's generated client-side via JavaScript DrawCaptcha() function
    // Since we can't execute JavaScript, we need to generate it ourselves using the same algorithm
    // The DrawCaptcha() function generates: a + b + c + d + e + f + g (7 random digits)
    // We'll generate our own captcha using the same logic
    const captchaValue = generateCaptcha();
    console.log(`Captcha generated: ${captchaValue}`);

    return {
      otp,
      captcha: captchaValue,
      cookies: cookieJar
    };
  } catch (error) {
    console.error(`Error initializing CRSTN session for job ${jobId}:`, error.message);
    throw error;
  }
}

// Function to poll CRSTN website for a specific date
async function pollCRSTNForDate(jobId, mobileNumber, gender, otp, captcha, dateOfDeath) {
  try {
    const cookieJar = jobCookieJars.get(jobId);
    if (!cookieJar) {
      return {
        success: false,
        error: 'Session not initialized. Cookie jar not found.',
        date: dateOfDeath
      };
    }

    const axiosWithCookies = wrapper(axios.create({ 
      jar: cookieJar,
      withCredentials: true 
    }));

    // Convert date format from YYYY-MM-DD to DD-MM-YYYY
    const dateParts = dateOfDeath.split('-');
    const formattedDate = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;

    // Submit form to DCert endpoint
    const response = await axiosWithCookies.post(
      'https://www.crstn.org/birth_death_tn/DCert',
      new URLSearchParams({
        txt_rchid: '',
        selectGender: gender, // M for Male, F for Female, G for Transgender
        sel_dst: '1005', // Coimbatore
        rd_bd_type: '2', // Home/Others
        dod: formattedDate, // Date of death in DD-MM-YYYY format
        txt_mob: mobileNumber,
        txt_otp: otp,
        regcaptchNo: captcha,
        submit: 'View'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.crstn.org/birth_death_tn/DCert'
        },
        timeout: 30000,
        validateStatus: function (status) {
          return status >= 200 && status < 500;
        }
      }
    );

    if (typeof response.data === 'string' && (response.data.includes('<!DOCTYPE') || response.data.includes('<html'))) {
      return {
        success: true,
        data: response.data,
        date: dateOfDeath
      };
    }

    return {
      success: false,
      error: 'Invalid response format',
      date: dateOfDeath
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Request failed',
      date: dateOfDeath
    };
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
      searchName, // Keep for backward compatibility
      searchNames, // New: array of search names
      intervalMinutes = 60 
    } = req.body;
    
    // Normalize search names: use searchNames if provided, otherwise use searchName as array
    const normalizedSearchNames = searchNames && Array.isArray(searchNames) && searchNames.length > 0
      ? searchNames.filter(name => name && name.trim() !== '')
      : (searchName ? [searchName] : []);

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
      searchName: normalizedSearchNames.length > 0 ? normalizedSearchNames[0] : null, // Keep for backward compatibility
      searchNames: normalizedSearchNames.length > 0 ? normalizedSearchNames : null, // New: array of names
      foundDates: [],
      allRecords: [],
      status: 'initializing',
      startTime: new Date().toISOString(),
      lastUpdate: null,
      totalRequests: 0,
      errors: [],
      errorDates: [], // Track dates that had errors for retry
      retryingErrors: false // Flag to indicate if currently retrying error dates
    };

    activeJobs.set(jobId, results);

    // Start polling in background (will initialize session automatically)
    startPollingJob(jobId, verificationNumber, token, dates, gender, normalizedSearchNames, intervalMinutes);

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
        timeout: 30000,
        validateStatus: function (status) {
          // Accept all status codes to handle errors gracefully
          return status >= 200 && status < 500;
        }
      }
    );

    // Log response for debugging
    console.log(`[${date}] Response status: ${response.status}, Data type: ${typeof response.data}`);

    // Check if response is HTML (error page)
    if (typeof response.data === 'string' && (response.data.includes('<!DOCTYPE') || response.data.includes('<html'))) {
      console.error(`[${date}] Received HTML instead of JSON. Possible error page.`);
      return {
        success: false,
        error: 'Server returned HTML error page',
        date
      };
    }

    // Handle different response formats
    if (response.data) {
      // Standard success response
      if (response.data.status && response.data.data) {
        return {
          success: true,
          data: response.data.data,
          date
        };
      }
      
      // Response with status but no data (empty results)
      if (response.data.status === true || response.data.status === 'success') {
        return {
          success: true,
          data: '', // Empty HTML means no records
          date
        };
      }
      
      // Response with false status
      if (response.data.status === false) {
        return {
          success: true,
          data: '', // No records for this date
          date
        };
      }
      
      // If data exists but no status field
      if (response.data.data) {
        return {
          success: true,
          data: response.data.data,
          date
        };
      }
      
      // Log unexpected format
      console.error(`[${date}] Unexpected response format:`, JSON.stringify(response.data).substring(0, 200));
    }

    return {
      success: false,
      error: `Invalid response format: ${JSON.stringify(response.data).substring(0, 100)}`,
      date
    };
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
    
    // Log the actual error for debugging
    console.error(`[${date}] Request error:`, error.message);
    if (error.response) {
      console.error(`[${date}] Response status: ${error.response.status}`);
      console.error(`[${date}] Response data:`, typeof error.response.data === 'string' 
        ? error.response.data.substring(0, 200) 
        : JSON.stringify(error.response.data).substring(0, 200));
    }
    
    return {
      success: false,
      error: error.message || 'Request failed',
      date
    };
  }
}

// Main polling function
async function startPollingJob(jobId, verificationNumber, providedToken, dates, gender, searchNames, intervalMinutes) {
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
    job.retryingErrors = false; // Reset retry flag

    // Check if we need to reinitialize session (if token expired)
    let needsReinit = false;
    const errorDatesToRetry = []; // Track dates that fail in this cycle

    for (const date of dates) {
      if (!activeJobs.has(jobId)) break; // Check if job still exists

      const result = await pollForDate(jobId, finalVerificationNumber, csrfToken, date, gender);
      job.totalRequests++;

      if (result.success) {
        needsReinit = false; // Reset flag on success
        // Remove from error dates if it was there
        job.errorDates = job.errorDates.filter(d => d !== date);
        const records = parseCertificateData(result.data);
        
        // Check for search names if provided
        if (searchNames && searchNames.length > 0) {
          const matchingRecords = records.map(record => {
            let bestOverallMatch = null;
            let bestSearchName = null;
            
            // Check each search name
            for (const searchName of searchNames) {
              const nameMatch = nameMatches(searchName, record.name);
              const fatherMatch = nameMatches(searchName, record.fathersName);
              const motherMatch = nameMatches(searchName, record.mothersName);
              
              // Get the best match for this search name (highest score)
              const matches = [nameMatch, fatherMatch, motherMatch].filter(m => m.match);
              if (matches.length > 0) {
                const bestMatch = matches.reduce((best, current) => 
                  current.score > best.score ? current : best
                );
                
                // Keep track of the overall best match across all search names
                if (!bestOverallMatch || bestMatch.score > bestOverallMatch.score) {
                  bestOverallMatch = bestMatch;
                  bestSearchName = searchName;
                }
              }
            }
            
            if (!bestOverallMatch) return null;
            
            // Determine which field matched
            const nameMatch = nameMatches(bestSearchName, record.name);
            const fatherMatch = nameMatches(bestSearchName, record.fathersName);
            const motherMatch = nameMatches(bestSearchName, record.mothersName);
            
            return {
              ...record,
              matchScore: bestOverallMatch.score,
              matchedField: nameMatch.match ? 'name' : (fatherMatch.match ? 'fathersName' : 'mothersName'),
              matchedPart: bestOverallMatch.matchedPart,
              matchedSearchName: bestSearchName // Track which search name matched
            };
          }).filter(record => record !== null)
          // Sort by match score (highest first)
          .sort((a, b) => b.matchScore - a.matchScore)
          // Show matches with score >= 30 (allows main name part matches)
          // This allows "kowsalya" to match "D.KOWSALYA" when main part matches
          .filter(record => {
            const passes = record.matchScore >= 30;
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
            
            console.log(`Found ${matchingRecords.length} matching record(s) for "${searchNames.join(', ')}" on date ${date}`);
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
              
              if (searchNames && searchNames.length > 0) {
                const matchingRecords = records.map(record => {
                  let bestOverallMatch = null;
                  let bestSearchName = null;
                  
                  for (const searchName of searchNames) {
                    const nameMatch = nameMatches(searchName, record.name);
                    const fatherMatch = nameMatches(searchName, record.fathersName);
                    const motherMatch = nameMatches(searchName, record.mothersName);
                    
                    const matches = [nameMatch, fatherMatch, motherMatch].filter(m => m.match);
                    if (matches.length > 0) {
                      const bestMatch = matches.reduce((best, current) => 
                        current.score > best.score ? current : best
                      );
                      
                      if (!bestOverallMatch || bestMatch.score > bestOverallMatch.score) {
                        bestOverallMatch = bestMatch;
                        bestSearchName = searchName;
                      }
                    }
                  }
                  
                  if (!bestOverallMatch) return null;
                  
                  const nameMatch = nameMatches(bestSearchName, record.name);
                  const fatherMatch = nameMatches(bestSearchName, record.fathersName);
                  const motherMatch = nameMatches(bestSearchName, record.mothersName);
                  
                  return {
                    ...record,
                    matchScore: bestOverallMatch.score,
                    matchedField: nameMatch.match ? 'name' : (fatherMatch.match ? 'fathersName' : 'mothersName'),
                    matchedPart: bestOverallMatch.matchedPart,
                    matchedSearchName: bestSearchName
                  };
                }).filter(record => record !== null)
                  .sort((a, b) => b.matchScore - a.matchScore)
                  .filter(record => record.matchScore >= 30);
                
                if (matchingRecords.length > 0) {
                  const foundEntry = { 
                    date, 
                    records: matchingRecords,
                    totalRecordsOnDate: records.length
                  };
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
                }
              }
              continue; // Skip error logging for retry success
            }
          } catch (reinitError) {
            console.error(`Failed to reinitialize session for job ${jobId}:`, reinitError);
          }
        }
        
        // Track error date for retry (only if not a CSRF token issue)
        if (!result.needsReinit && !result.error.includes('419')) {
          if (!job.errorDates.includes(date)) {
            job.errorDates.push(date);
          }
          errorDatesToRetry.push(date);
        }
        
        job.errors.push({
          date,
          error: result.error,
          timestamp: new Date().toISOString()
        });
      }

      // Small delay between requests to avoid overwhelming the API and reduce rate limiting
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // After main cycle, retry error dates once
    if (errorDatesToRetry.length > 0 && activeJobs.has(jobId)) {
      console.log(`Retrying ${errorDatesToRetry.length} error date(s) for job ${jobId}...`);
      job.status = 'retrying_errors';
      job.retryingErrors = true;
      job.lastUpdate = new Date().toISOString();

      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 2000));

      for (const errorDate of errorDatesToRetry) {
        if (!activeJobs.has(jobId)) break;

        console.log(`Retrying date ${errorDate}...`);
        const retryResult = await pollForDate(jobId, finalVerificationNumber, csrfToken, errorDate, gender);
        job.totalRequests++;

        if (retryResult.success) {
          // Remove from error dates
          job.errorDates = job.errorDates.filter(d => d !== errorDate);
          // Remove from errors array
          job.errors = job.errors.filter(e => e.date !== errorDate);
          
          const records = parseCertificateData(retryResult.data);
          
          if (searchNames && searchNames.length > 0) {
            const matchingRecords = records.map(record => {
              let bestOverallMatch = null;
              let bestSearchName = null;
              
              for (const searchName of searchNames) {
                const nameMatch = nameMatches(searchName, record.name);
                const fatherMatch = nameMatches(searchName, record.fathersName);
                const motherMatch = nameMatches(searchName, record.mothersName);
                
                const matches = [nameMatch, fatherMatch, motherMatch].filter(m => m.match);
                if (matches.length > 0) {
                  const bestMatch = matches.reduce((best, current) => 
                    current.score > best.score ? current : best
                  );
                  
                  if (!bestOverallMatch || bestMatch.score > bestOverallMatch.score) {
                    bestOverallMatch = bestMatch;
                    bestSearchName = searchName;
                  }
                }
              }
              
              if (!bestOverallMatch) return null;
              
              const nameMatch = nameMatches(bestSearchName, record.name);
              const fatherMatch = nameMatches(bestSearchName, record.fathersName);
              const motherMatch = nameMatches(bestSearchName, record.mothersName);
              
              return {
                ...record,
                matchScore: bestOverallMatch.score,
                matchedField: nameMatch.match ? 'name' : (fatherMatch.match ? 'fathersName' : 'mothersName'),
                matchedPart: bestOverallMatch.matchedPart,
                matchedSearchName: bestSearchName
              };
            }).filter(record => record !== null)
              .sort((a, b) => b.matchScore - a.matchScore)
              .filter(record => record.matchScore >= 30);

            if (matchingRecords.length > 0) {
              matchingRecords.forEach(record => {
                record.date = errorDate;
              });
              
              const foundEntry = {
                date: errorDate,
                records: matchingRecords,
                totalRecordsOnDate: records.length
              };
              
              const existingIndex = job.foundDates.findIndex(f => f.date === errorDate);
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
              
              console.log(`Successfully retried date ${errorDate} - found ${matchingRecords.length} matching record(s)`);
            }
          } else {
            records.forEach(record => {
              record.date = errorDate;
              job.allRecords.push(record);
            });
            
            if (job.allRecords.length > 1000) {
              job.allRecords = job.allRecords.slice(-1000);
            }
          }
        } else {
          // Still failed after retry, update error
          const errorIndex = job.errors.findIndex(e => e.date === errorDate);
          if (errorIndex >= 0) {
            job.errors[errorIndex] = {
              date: errorDate,
              error: `Retry failed: ${retryResult.error}`,
              timestamp: new Date().toISOString()
            };
          }
          console.log(`Retry failed for date ${errorDate}: ${retryResult.error}`);
        }

        // Delay between retry requests
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      job.retryingErrors = false;
      job.status = 'running';
      job.lastUpdate = new Date().toISOString();
      console.log(`Finished retrying error dates for job ${jobId}`);
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

// API endpoint to start polling for CRSTN website
app.post('/api/start-polling-crstn', async (req, res) => {
  try {
    const { 
      mobileNumber = '8825733700',
      gender = 'M', // M for Male, F for Female, G for Transgender
      dateOfDeath, // Single date to search
      startDate, // Optional: for date range search
      endDate, // Optional: for date range search
      searchNames, // Array of search names
      intervalMinutes = 60 
    } = req.body;
    
    if (!mobileNumber || mobileNumber.length !== 10) {
      return res.status(400).json({ 
        error: 'Mobile number must be 10 digits' 
      });
    }

    // Determine dates to search
    let dates = [];
    if (dateOfDeath) {
      dates = [dateOfDeath];
    } else if (startDate && endDate) {
      dates = getDatesInRange(startDate, endDate);
    } else {
      return res.status(400).json({ 
        error: 'Either dateOfDeath or both startDate and endDate must be provided' 
      });
    }

    // If dateOfDeath is provided, use it; otherwise use startDate/endDate range
    // This allows searching a single date or a range

    const normalizedSearchNames = searchNames && Array.isArray(searchNames) && searchNames.length > 0
      ? searchNames.filter(name => name && name.trim() !== '')
      : [];

    const jobId = `job_crstn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create a cookie jar for this job
    const cookieJar = new CookieJar();
    jobCookieJars.set(jobId, cookieJar);
    
    const results = {
      jobId,
      searchName: normalizedSearchNames.length > 0 ? normalizedSearchNames[0] : null,
      searchNames: normalizedSearchNames.length > 0 ? normalizedSearchNames : null,
      foundDates: [],
      allRecords: [],
      status: 'initializing',
      startTime: new Date().toISOString(),
      lastUpdate: null,
      totalRequests: 0,
      errors: [],
      errorDates: [],
      retryingErrors: false,
      website: 'crstn'
    };

    activeJobs.set(jobId, results);

    // Start polling in background
    startCRSTNPollingJob(jobId, mobileNumber, gender, dates, normalizedSearchNames, intervalMinutes);

    res.json({ 
      jobId, 
      message: 'CRSTN polling started. Session will be initialized automatically.',
      totalDates: dates.length
    });
  } catch (error) {
    console.error('Error starting CRSTN polling:', error);
    res.status(500).json({ error: error.message });
  }
});

// Main polling function for CRSTN website
async function startCRSTNPollingJob(jobId, mobileNumber, gender, dates, searchNames, intervalMinutes) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  const pollInterval = intervalMinutes * 60 * 1000;
  let otp = null;
  let captcha = null;

  // Initialize session and get OTP + captcha
  try {
    job.status = 'initializing';
    job.lastUpdate = new Date().toISOString();
    
    console.log(`Initializing CRSTN session for job ${jobId}...`);
    const sessionData = await initializeCRSTNSession(jobId, mobileNumber);
    otp = sessionData.otp;
    captcha = sessionData.captcha;
    
    console.log(`CRSTN session initialized. OTP: ${otp}, Captcha: ${captcha}`);
    job.status = 'running';
  } catch (error) {
    job.status = 'error';
    job.errors.push({
      date: 'initialization',
      error: `Failed to initialize CRSTN session: ${error.message}`,
      timestamp: new Date().toISOString()
    });
    console.error(`Failed to initialize CRSTN session for job ${jobId}:`, error);
    return;
  }

  let lastOTPTime = Date.now();
  const OTP_VALIDITY_MS = 4 * 60 * 1000; // 4 minutes (slightly less than 5 to be safe)

  async function runPollCycle() {
    if (!activeJobs.has(jobId)) return;

    job.status = 'running';
    job.lastUpdate = new Date().toISOString();
    job.retryingErrors = false;

    // Reinitialize session for each cycle (OTP expires after 5 minutes)
    try {
      const sessionData = await initializeCRSTNSession(jobId, mobileNumber);
      otp = sessionData.otp;
      captcha = sessionData.captcha;
      lastOTPTime = Date.now();
      console.log(`Reinitialized CRSTN session. OTP: ${otp}, Captcha: ${captcha}`);
    } catch (error) {
      console.error(`Failed to reinitialize CRSTN session:`, error);
      job.errors.push({
        date: 'reinitialization',
        error: `Failed to reinitialize: ${error.message}`,
        timestamp: new Date().toISOString()
      });
      // If reinitialization fails, skip this cycle
      if (activeJobs.has(jobId)) {
        setTimeout(runPollCycle, pollInterval);
      }
      return;
    }

    const errorDatesToRetry = [];

    for (const date of dates) {
      if (!activeJobs.has(jobId)) break;

      // IMPORTANT: Each "View" requires a NEW OTP - one OTP can only be used once
      // So we need to get a fresh OTP and captcha for EACH date search
      try {
        console.log(`Getting fresh OTP and captcha for date ${date}...`);
        const sessionData = await initializeCRSTNSession(jobId, mobileNumber);
        otp = sessionData.otp;
        captcha = sessionData.captcha; // Generate new captcha for each request
        lastOTPTime = Date.now();
        console.log(`Fresh session for date ${date}. OTP: ${otp}, Captcha: ${captcha}`);
      } catch (error) {
        console.error(`Failed to get fresh session for date ${date}:`, error);
        job.errors.push({
          date,
          error: `Failed to get fresh OTP: ${error.message}`,
          timestamp: new Date().toISOString()
        });
        continue; // Skip this date if we can't get fresh OTP
      }

      const result = await pollCRSTNForDate(jobId, mobileNumber, gender, otp, captcha, date);
      job.totalRequests++;

      if (result.success) {
        job.errorDates = job.errorDates.filter(d => d !== date);
        const records = parseCRSTNCertificateData(result.data);
        
        if (searchNames && searchNames.length > 0) {
          const matchingRecords = records.map(record => {
            let bestOverallMatch = null;
            let bestSearchName = null;
            
            for (const searchName of searchNames) {
              const nameMatch = nameMatches(searchName, record.name);
              const fatherMatch = nameMatches(searchName, record.fathersName);
              const motherMatch = nameMatches(searchName, record.mothersName);
              
              const matches = [nameMatch, fatherMatch, motherMatch].filter(m => m.match);
              if (matches.length > 0) {
                const bestMatch = matches.reduce((best, current) => 
                  current.score > best.score ? current : best
                );
                
                if (!bestOverallMatch || bestMatch.score > bestOverallMatch.score) {
                  bestOverallMatch = bestMatch;
                  bestSearchName = searchName;
                }
              }
            }
            
            if (!bestOverallMatch) return null;
            
            const nameMatch = nameMatches(bestSearchName, record.name);
            const fatherMatch = nameMatches(bestSearchName, record.fathersName);
            const motherMatch = nameMatches(bestSearchName, record.mothersName);
            
            return {
              ...record,
              matchScore: bestOverallMatch.score,
              matchedField: nameMatch.match ? 'name' : (fatherMatch.match ? 'fathersName' : 'mothersName'),
              matchedPart: bestOverallMatch.matchedPart,
              matchedSearchName: bestSearchName
            };
          }).filter(record => record !== null)
            .sort((a, b) => b.matchScore - a.matchScore)
            .filter(record => record.matchScore >= 30);

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
            
            console.log(`Found ${matchingRecords.length} matching record(s) for "${searchNames.join(', ')}" on date ${date}`);
          }
        } else {
          // Store records by date for CRSTN to show parsing verification
          records.forEach(record => {
            record.date = date;
            job.allRecords.push(record);
          });
          
          // Also store records grouped by date for easier display
          if (!job.recordsByDate) {
            job.recordsByDate = {};
          }
          job.recordsByDate[date] = {
            date,
            records: records,
            count: records.length
          };
          
          if (job.allRecords.length > 1000) {
            job.allRecords = job.allRecords.slice(-1000);
          }
        }
      } else {
        if (!job.errorDates.includes(date)) {
          job.errorDates.push(date);
        }
        errorDatesToRetry.push(date);
        
        job.errors.push({
          date,
          error: result.error,
          timestamp: new Date().toISOString()
        });
      }

      await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between requests
    }

    // Schedule next poll cycle
    if (activeJobs.has(jobId)) {
      setTimeout(runPollCycle, pollInterval);
    }
  }

  // Start first cycle immediately
  runPollCycle();
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

