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
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    )

    const url = new URL(req.url)
    const userId = url.pathname.split('/').pop()

    if (!userId) {
      return new Response(
        JSON.stringify({ error: 'User ID required' }),
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
      const body = await req.json()
      const { action, file_path, file_hash } = body

      console.log(`Sync action: ${action} for file: ${file_path}`)

      // Log sync activity
      const { error: logError } = await supabase
        .from('sync_logs')
        .insert({
          user_id: userId,
          action,
          file_path,
          file_hash,
          sync_timestamp: new Date().toISOString()
        })

      if (logError) {
        console.error('Error logging sync:', logError)
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          message: `Sync ${action} completed for ${file_path}` 
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