#!/bin/bash

# Local test script for Cloudflare Workers
# Make sure to run: npm run dev:worker (or wrangler dev) in another terminal first

LOCAL_URL="http://localhost:8787"

echo "Testing Cloudflare Workers Locally..."
echo "======================================"
echo ""
echo "Make sure you have 'wrangler dev' running in another terminal!"
echo "Press Enter to continue..."
read
echo ""

# Test 1: Health Check
echo "1. Testing GET /api/health"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$LOCAL_URL/api/health")
http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE/d')
echo "Response: $body"
echo "HTTP Code: $http_code"
if [ "$http_code" = "200" ]; then
  echo "✅ Health check passed"
else
  echo "❌ Health check failed"
fi
echo ""

# Test 2: List Jobs (should be empty initially)
echo "2. Testing GET /api/jobs"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$LOCAL_URL/api/jobs")
http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE/d')
echo "Response: $body"
echo "HTTP Code: $http_code"
if [ "$http_code" = "200" ]; then
  echo "✅ List jobs passed"
else
  echo "❌ List jobs failed"
fi
echo ""

# Test 3: Start Polling with the configuration from the image
echo "3. Testing POST /api/start-polling"
echo "   Config: Start Date: 2004-09-15, End Date: 2004-09-30, Gender: female, Search Name: kowsalya, Interval: 60"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2004-09-15",
    "endDate": "2004-09-30",
    "gender": "female",
    "searchName": "kowsalya",
    "intervalMinutes": 60
  }' \
  "$LOCAL_URL/api/start-polling")
http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE/d')
echo "Response: $body"
echo "HTTP Code: $http_code"
if [ "$http_code" = "200" ]; then
  echo "✅ Start polling passed"
  # Extract jobId for next test
  job_id=$(echo "$body" | grep -o '"jobId":"[^"]*' | cut -d'"' -f4)
  echo "Job ID: $job_id"
else
  echo "❌ Start polling failed"
  job_id=""
fi
echo ""

# Test 4: Get Job Status (if job was created)
if [ -n "$job_id" ]; then
  echo "4. Testing GET /api/job/$job_id"
  echo "   Waiting 5 seconds for initialization..."
  sleep 5
  response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$LOCAL_URL/api/job/$job_id")
  http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
  body=$(echo "$response" | sed '/HTTP_CODE/d')
  echo "Response: $body"
  echo "HTTP Code: $http_code"
  if [ "$http_code" = "200" ]; then
    echo "✅ Get job status passed"
    # Check job status
    status=$(echo "$body" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    echo "Job Status: $status"
  else
    echo "❌ Get job status failed"
  fi
  echo ""
  
  # Test 5: List Jobs again (should show the new job)
  echo "5. Testing GET /api/jobs (should show the new job)"
  response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$LOCAL_URL/api/jobs")
  http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
  body=$(echo "$response" | sed '/HTTP_CODE/d')
  echo "Response: $body"
  echo "HTTP Code: $http_code"
  if [ "$http_code" = "200" ]; then
    echo "✅ List jobs passed"
  else
    echo "❌ List jobs failed"
  fi
  echo ""
  
  # Test 6: Monitor job status (check every 10 seconds)
  echo "6. Monitoring job status (press Ctrl+C to stop)"
  echo "   Checking job status every 10 seconds..."
  for i in {1..6}; do
    echo ""
    echo "--- Check #$i ---"
    response=$(curl -s "$LOCAL_URL/api/job/$job_id")
    status=$(echo "$response" | grep -o '"status":"[^"]*' | cut -d'"' -f4)
    found_dates=$(echo "$response" | grep -o '"foundDates":\[[^]]*\]' | wc -l)
    total_requests=$(echo "$response" | grep -o '"totalRequests":[0-9]*' | cut -d: -f2)
    errors=$(echo "$response" | grep -o '"errors":\[[^]]*\]' | wc -l)
    echo "Status: $status"
    echo "Total Requests: $total_requests"
    echo "Found Dates Count: $found_dates"
    if [ "$status" = "error" ]; then
      echo "⚠️  Job has errors - check the response for details"
      break
    fi
    if [ "$i" -lt 6 ]; then
      sleep 10
    fi
  done
  echo ""
fi

echo "======================================"
echo "Testing complete!"
echo ""


