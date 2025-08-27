-- Insert demo user for P2P client testing (using INSERT ... WHERE NOT EXISTS to avoid conflicts)
INSERT INTO bucket_licenses (user_id, license_key, bucket_size_gb, max_buckets, is_active) 
SELECT 'df38baa3-fce6-4f08-9d05-664dd33a0244', 'DEMO-P2P-TEST', 5, 10, true
WHERE NOT EXISTS (
  SELECT 1 FROM bucket_licenses 
  WHERE user_id = 'df38baa3-fce6-4f08-9d05-664dd33a0244' 
  AND license_key = 'DEMO-P2P-TEST'
);