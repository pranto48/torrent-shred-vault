-- Insert demo user for P2P client testing
INSERT INTO bucket_licenses (user_id, license_key, bucket_size_gb, max_buckets, is_active) 
VALUES ('df38baa3-fce6-4f08-9d05-664dd33a0244', 'DEMO-P2P-TEST', 5, 10, true) 
ON CONFLICT (user_id, license_key) DO NOTHING;