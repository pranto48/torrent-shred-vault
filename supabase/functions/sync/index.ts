import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const url = new URL(req.url)
    const pathParts = url.pathname.split('/')
    const userId = pathParts[pathParts.length - 1]

    console.log('Sync request:', { method: req.method, userId, pathname: url.pathname })

    if (!userId || userId === 'sync') {
      return new Response(
        JSON.stringify({ error: 'User ID required in path' }),
        { 
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    if (req.method === 'GET') {
      // Get user's bucket files for syncing
      const { data: buckets, error: bucketsError } = await supabase
        .from('bucket_licenses')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)

      if (bucketsError) {
        console.error('Error fetching buckets:', bucketsError)
        return new Response(
          JSON.stringify({ error: 'Failed to fetch buckets' }),
          { 
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      // Get files from storage for each bucket
      const syncData = []
      for (const bucket of buckets || []) {
        const { data: files, error: filesError } = await supabase.storage
          .from('user-files')
          .list(`${userId}/${bucket.license_key}`)

        if (!filesError && files) {
          for (const file of files) {
            const magnetLink = `magnet:?xt=urn:btih:${generateHashFromFile(file.name)}&dn=${encodeURIComponent(file.name)}&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.publicbt.com:80`
            
            syncData.push({
              bucket_id: bucket.license_key,
              file_name: file.name,
              file_size: file.metadata?.size || 0,
              magnet_link: magnetLink,
              last_modified: file.updated_at || file.created_at,
              file_path: `${userId}/${bucket.license_key}/${file.name}`
            })
          }
        }
      }

      return new Response(
        JSON.stringify({
          user_id: userId,
          sync_timestamp: new Date().toISOString(),
          files: syncData,
          total_files: syncData.length
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    if (req.method === 'POST') {
      // Handle file sync updates
      let body;
      try {
        const bodyText = await req.text();
        if (!bodyText.trim()) {
          return new Response(
            JSON.stringify({ error: 'Request body is empty' }),
            { 
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          )
        }
        body = JSON.parse(bodyText);
      } catch (parseError) {
        console.error('JSON parse error:', parseError)
        return new Response(
          JSON.stringify({ error: 'Invalid JSON in request body' }),
          { 
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      const { action, file_path, file_hash } = body

      console.log(`Sync action: ${action} for file: ${file_path} by user: ${userId}`)

      // Validate userId is a proper UUID
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(userId)) {
        return new Response(
          JSON.stringify({ error: 'Invalid user ID format' }),
          { 
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        )
      }

      // Log sync activity
      const { error: logError } = await supabase
        .from('sync_logs')
        .insert({
          user_id: userId,
          action: action || 'unknown',
          file_path: file_path || 'unknown',
          file_hash: file_hash || null,
          sync_timestamp: new Date().toISOString()
        })

      if (logError) {
        console.error('Error logging sync:', logError)
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          message: `Sync ${action} completed for ${file_path}`,
          user_id: userId
        }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      )
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { 
        status: 405,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )

  } catch (error) {
    console.error('Sync API error:', error)
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    )
  }
})

function generateHashFromFile(fileName: string): string {
  // Simple hash generation for demo - in production use proper hashing
  let hash = 0
  for (let i = 0; i < fileName.length; i++) {
    const char = fileName.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0').repeat(5).substring(0, 40)
}