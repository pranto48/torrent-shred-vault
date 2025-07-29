-- Fix the gen_random_uuid() function reference
-- Enable the required extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Drop and recreate the handle_new_user function with correct UUID generation
DROP FUNCTION IF EXISTS public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, display_name)
  VALUES (
    NEW.id, 
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
  );
  
  -- Create a default bucket license for new users
  INSERT INTO public.bucket_licenses (user_id, license_key, bucket_size_gb, max_buckets)
  VALUES (
    NEW.id,
    'BL-' || UPPER(SUBSTRING(uuid_generate_v4()::text, 1, 8)),
    1,
    5
  );
  
  RETURN NEW;
END;
$$;

-- Recreate the trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();