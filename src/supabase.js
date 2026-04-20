import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = "https://kozxywufvmpwjnrsoko.supabase.co"
const SUPABASE_KEY = "sb_publishable_eN429Kmvz9abtTuoWSNsfg_GKBta2Q3"

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)