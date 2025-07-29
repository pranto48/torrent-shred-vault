-- Ensure uuid-ossp extension is enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Check if the extension is working by testing the function
SELECT uuid_generate_v4();