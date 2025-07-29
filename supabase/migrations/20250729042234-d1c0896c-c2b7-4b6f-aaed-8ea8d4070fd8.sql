-- Fix security warnings by setting proper search paths
DROP FUNCTION IF EXISTS public.has_role(UUID, app_role);
DROP FUNCTION IF EXISTS public.is_current_user_admin();

-- Recreate functions with proper search paths
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
      AND is_active = true
  )
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT public.has_role(auth.uid(), 'admin'::app_role)
$$;