// Cloudflare Worker with Durable Objects for stateful job management
import { JobDurableObject } from './JobDurableObject.js';

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

// CORS headers helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

// Get Durable Object stub for a job
function getJobObject(env, jobId) {
  const id = env.JOB_DO.idFromName(jobId);
  return env.JOB_DO.get(id);
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

        // Get Durable Object for this job
        const jobObject = getJobObject(env, jobId);

        // Initialize the job in the Durable Object
        const initResponse = await jobObject.fetch(new Request(`${url.origin}/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            verificationNumber,
            token,
            dates,
            gender,
            searchName,
            intervalMinutes
          })
        }));

        const initResult = await initResponse.json();

        if (!initResult.success) {
          return new Response(JSON.stringify({ 
            error: initResult.error || 'Failed to initialize job' 
          }), {
            status: 500,
            headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
          });
        }

        // Store job ID in KV for listing (optional)
        if (env.JOBS_STORE) {
          try {
            const jobsIndex = await env.JOBS_STORE.get('jobs:index');
            const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];
            if (!jobIds.includes(jobId)) {
              jobIds.push(jobId);
              await env.JOBS_STORE.put('jobs:index', JSON.stringify(jobIds));
            }
          } catch (error) {
            console.error('Error updating jobs index:', error);
          }
        }

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

      try {
        const jobObject = getJobObject(env, jobId);
        const statusResponse = await jobObject.fetch(new Request(`${url.origin}/status`, {
          method: 'GET'
        }));

        const job = await statusResponse.json();

        if (job.error) {
          return new Response(JSON.stringify({ error: job.error }), {
            status: 404,
            headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
          });
        }

        return new Response(JSON.stringify(job), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error getting job status:', error);
        return new Response(JSON.stringify({ error: 'Job not found' }), {
          status: 404,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
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

      try {
        const jobObject = getJobObject(env, jobId);
        const stopResponse = await jobObject.fetch(new Request(`${url.origin}/stop`, {
          method: 'POST'
        }));

        const result = await stopResponse.json();

        // Remove from jobs index
        if (env.JOBS_STORE) {
          try {
            const jobsIndex = await env.JOBS_STORE.get('jobs:index');
            const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];
            const filtered = jobIds.filter(id => id !== jobId);
            await env.JOBS_STORE.put('jobs:index', JSON.stringify(filtered));
          } catch (error) {
            console.error('Error updating jobs index:', error);
          }
        }

        return new Response(JSON.stringify(result), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error stopping job:', error);
        return new Response(JSON.stringify({ error: 'Job not found' }), {
          status: 404,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
    }

    // List all jobs
    if (path === '/api/jobs' && method === 'GET') {
      try {
        const jobsList = [];

        if (env.JOBS_STORE) {
          try {
            const jobsIndex = await env.JOBS_STORE.get('jobs:index');
            const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];

            // Fetch status for each job
            for (const jobId of jobIds) {
              try {
                const jobObject = getJobObject(env, jobId);
                const statusResponse = await jobObject.fetch(new Request(`${url.origin}/status`, {
                  method: 'GET'
                }));

                const job = await statusResponse.json();
                if (job && !job.error) {
                  jobsList.push({
                    jobId,
                    searchName: job.searchName,
                    status: job.status,
                    startTime: job.startTime,
                    lastUpdate: job.lastUpdate,
                    foundDatesCount: job.foundDates?.length || 0,
                    totalRequests: job.totalRequests || 0
                  });
                }
              } catch (error) {
                console.error(`Error fetching job ${jobId}:`, error);
                // Remove invalid job from index
                const jobsIndex = await env.JOBS_STORE.get('jobs:index');
                const jobIds = jobsIndex ? JSON.parse(jobsIndex) : [];
                const filtered = jobIds.filter(id => id !== jobId);
                await env.JOBS_STORE.put('jobs:index', JSON.stringify(filtered));
              }
            }
          } catch (error) {
            console.error('Error reading jobs index:', error);
          }
        }

        return new Response(JSON.stringify({ jobs: jobsList }), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      } catch (error) {
        console.error('Error listing jobs:', error);
        return new Response(JSON.stringify({ jobs: [] }), {
          headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
        });
      }
    }

    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
    });
  }
};

// Export Durable Object class
export { JobDurableObject };
