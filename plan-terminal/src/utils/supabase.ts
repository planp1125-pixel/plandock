import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://xpxzssueokeomxopzdbr.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhweHpzc3Vlb2tlb214b3B6ZGJyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MTA1MjUsImV4cCI6MjA5MDI4NjUyNX0.2kQAQJpXEqIduP0eVYn22JSRZMHauJ3mh8tnCS5Ftbc';

export const supabase = createClient(supabaseUrl, supabaseKey);
