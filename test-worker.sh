#!/bin/bash

# Test script for Cloudflare Workers endpoints
WORKER_URL="https://dc-backend.madhav2004cbe.workers.dev"

echo "Testing Cloudflare Workers Endpoints..."
echo "========================================"
echo ""

# Test 1: Health Check
echo "1. Testing GET /api/health"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$WORKER_URL/api/health")
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

# Test 2: List Jobs
echo "2. Testing GET /api/jobs"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$WORKER_URL/api/jobs")
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

# Test 3: Start Polling
echo "3. Testing POST /api/start-polling"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": "2004-09-15",
    "endDate": "2004-09-16",
    "gender": "female",
    "searchName": "test",
    "intervalMinutes": 60
  }' \
  "$WORKER_URL/api/start-polling")
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
  sleep 2  # Wait a bit for job to initialize
  response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$WORKER_URL/api/job/$job_id")
  http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
  body=$(echo "$response" | sed '/HTTP_CODE/d')
  echo "Response: $body"
  echo "HTTP Code: $http_code"
  if [ "$http_code" = "200" ]; then
    echo "✅ Get job status passed"
  else
    echo "❌ Get job status failed"
  fi
  echo ""
  
  # Test 5: Delete Job
  echo "5. Testing DELETE /api/job/$job_id"
  response=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
    -X DELETE \
    "$WORKER_URL/api/job/$job_id")
  http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
  body=$(echo "$response" | sed '/HTTP_CODE/d')
  echo "Response: $body"
  echo "HTTP Code: $http_code"
  if [ "$http_code" = "200" ]; then
    echo "✅ Delete job passed"
  else
    echo "❌ Delete job failed"
  fi
  echo ""
else
  echo "4. Skipping job status test (no job ID)"
  echo "5. Skipping delete job test (no job ID)"
  echo ""
fi

# Test 6: CORS Preflight
echo "6. Testing OPTIONS (CORS preflight)"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" \
  -X OPTIONS \
  -H "Origin: https://example.com" \
  -H "Access-Control-Request-Method: POST" \
  "$WORKER_URL/api/start-polling")
http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
echo "HTTP Code: $http_code"
if [ "$http_code" = "200" ] || [ "$http_code" = "204" ]; then
  echo "✅ CORS preflight passed"
else
  echo "❌ CORS preflight failed"
fi
echo ""

# Test 7: 404 Not Found
echo "7. Testing 404 for invalid endpoint"
response=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$WORKER_URL/api/invalid")
http_code=$(echo "$response" | grep "HTTP_CODE" | cut -d: -f2)
body=$(echo "$response" | sed '/HTTP_CODE/d')
echo "Response: $body"
echo "HTTP Code: $http_code"
if [ "$http_code" = "404" ]; then
  echo "✅ 404 handling passed"
else
  echo "❌ 404 handling failed"
fi
echo ""

echo "========================================"
echo "Testing complete!"

