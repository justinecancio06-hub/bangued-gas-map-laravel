-- ============================================================================
-- Bangued Gas Station Map - MySQL schema + seed data for InfinityFree
--
-- Generated from the SQLite development database via the project's own
-- migrations. InfinityFree is MySQL-only and has no shell, so this file is
-- imported through phpMyAdmin instead of running `php artisan migrate`.
--
--   phpMyAdmin -> select your database -> Import -> choose this file -> Go
--
-- Contains: schema for all 12 tables, plus the 4 migration rows and the seed
-- data (1 admin user, 7 brands, 10 stations, 26 prices, 27 history rows).
-- Session and cache rows are deliberately NOT copied - they are dev leftovers.
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------- migrations
CREATE TABLE `migrations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `migration` varchar(255) NOT NULL,
  `batch` int NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------- cache
CREATE TABLE `cache` (
  `key` varchar(255) NOT NULL,
  `value` mediumtext NOT NULL,
  `expiration` int NOT NULL,
  PRIMARY KEY (`key`),
  KEY `cache_expiration_index` (`expiration`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `cache_locks` (
  `key` varchar(255) NOT NULL,
  `owner` varchar(255) NOT NULL,
  `expiration` int NOT NULL,
  PRIMARY KEY (`key`),
  KEY `cache_locks_expiration_index` (`expiration`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------- jobs
CREATE TABLE `jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `queue` varchar(255) NOT NULL,
  `payload` mediumtext NOT NULL,
  `attempts` tinyint unsigned NOT NULL,
  `reserved_at` int unsigned DEFAULT NULL,
  `available_at` int unsigned NOT NULL,
  `created_at` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `jobs_queue_index` (`queue`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `job_batches` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `total_jobs` int NOT NULL,
  `pending_jobs` int NOT NULL,
  `failed_jobs` int NOT NULL,
  `failed_job_ids` mediumtext NOT NULL,
  `options` mediumtext DEFAULT NULL,
  `cancelled_at` int unsigned DEFAULT NULL,
  `created_at` int unsigned NOT NULL,
  `finished_at` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `failed_jobs` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `uuid` varchar(255) NOT NULL,
  -- varchar, not text: both columns take part in a composite index below, and
  -- MySQL refuses to index a TEXT/BLOB column without a prefix length.
  `connection` varchar(255) NOT NULL,
  `queue` varchar(255) NOT NULL,
  `payload` mediumtext NOT NULL,
  `exception` mediumtext NOT NULL,
  `failed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `failed_jobs_uuid_unique` (`uuid`),
  KEY `failed_jobs_connection_queue_failed_at_index` (`connection`,`queue`,`failed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------------- users
CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `username` varchar(255) NOT NULL,
  -- bcrypt/argon hash copied verbatim from SQLite; hashing is portable, so the
  -- existing admin login keeps working after the move.
  `password_hash` varchar(255) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `role` varchar(255) NOT NULL DEFAULT 'admin',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_username_unique` (`username`),
  CONSTRAINT `users_role_check` CHECK (`role` in ('admin'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------------------- brands
CREATE TABLE `brands` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `slug` varchar(255) NOT NULL,
  `name` varchar(255) NOT NULL,
  `color_primary` varchar(255) NOT NULL,
  `color_secondary` varchar(255) DEFAULT NULL,
  `marker_icon` varchar(255) NOT NULL DEFAULT 'pump',
  -- Public/ paths, e.g. /images/brands/caltex.png. Served straight from
  -- public/, so no storage:link and no symlink support required.
  `logo_path` varchar(255) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT 100,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `brands_slug_unique` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------ stations
CREATE TABLE `stations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  -- unsigned on both sides: MySQL will not create a foreign key when the two
  -- column types differ.
  `brand_id` int unsigned NOT NULL,
  `name` varchar(255) NOT NULL,
  `address` varchar(255) DEFAULT NULL,
  `barangay` varchar(255) DEFAULT NULL,
  `latitude` double DEFAULT NULL,
  `longitude` double DEFAULT NULL,
  `contact_phone` varchar(255) DEFAULT NULL,
  `contact_email` varchar(255) DEFAULT NULL,
  `operating_hours` varchar(255) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `is_pending` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 1,
  `location_confidence` varchar(255) NOT NULL DEFAULT 'pending',
  `osm_ref` varchar(255) DEFAULT NULL,
  `created_at` datetime DEFAULT NULL,
  `updated_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `stations_brand_id_foreign` (`brand_id`),
  CONSTRAINT `stations_brand_id_foreign` FOREIGN KEY (`brand_id`) REFERENCES `brands` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `stations_location_confidence_check` CHECK (`location_confidence` in ('confirmed','approximate','pending'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------------- fuel_prices
CREATE TABLE `fuel_prices` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `station_id` int unsigned NOT NULL,
  `fuel_type` varchar(255) NOT NULL,
  `price_per_liter` double NOT NULL,
  `effective_at` datetime NOT NULL,
  `updated_at` datetime NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `fuel_prices_station_id_fuel_type_unique` (`station_id`,`fuel_type`),
  CONSTRAINT `fuel_prices_station_id_foreign` FOREIGN KEY (`station_id`) REFERENCES `stations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -------------------------------------------------------- fuel_price_history
CREATE TABLE `fuel_price_history` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `station_id` int unsigned NOT NULL,
  `fuel_type` varchar(255) NOT NULL,
  `previous_price` double DEFAULT NULL,
  `new_price` double NOT NULL,
  `changed_at` datetime NOT NULL,
  `changed_by` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fuel_price_history_station_id_foreign` (`station_id`),
  CONSTRAINT `fuel_price_history_station_id_foreign` FOREIGN KEY (`station_id`) REFERENCES `stations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------ sessions
CREATE TABLE `sessions` (
  `id` varchar(255) NOT NULL,
  `user_id` int unsigned DEFAULT NULL,
  `ip_address` varchar(255) DEFAULT NULL,
  `user_agent` text DEFAULT NULL,
  `payload` mediumtext NOT NULL,
  `last_activity` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  KEY `sessions_user_id_index` (`user_id`),
  KEY `sessions_last_activity_index` (`last_activity`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- === DATA ====================================================================
-- Inserted with FK checks off above, so row order does not matter.INSERT INTO migrations VALUES(1,'0001_01_01_000001_create_cache_table',1);
INSERT INTO migrations VALUES(2,'0001_01_01_000002_create_jobs_table',1);
INSERT INTO migrations VALUES(3,'2026_01_01_000000_create_bangued_tables',1);
INSERT INTO migrations VALUES(4,'2026_01_01_000001_create_sessions_table',1);
INSERT INTO users VALUES(1,'admin','$2y$12$s5jsUpk1Xu9hWSfBuO2vquqv6kJokBoAOlruGUqHme8NelVqBRVu.','Map Administrator','admin','2026-10-01 16:53:47','2026-10-02 01:04:56');
INSERT INTO brands VALUES(1,'shell','Shell','#FDDA00','#EE1C25','shell','/images/brands/shell.png',10,'2026-10-01 16:53:46');
INSERT INTO brands VALUES(2,'caltex','Caltex','#005EB8','#E31837','caltex','/images/brands/caltex.png',20,'2026-10-01 16:53:46');
INSERT INTO brands VALUES(3,'blu-gas','Blu Gas','#1E88E5','#00ACC1','pump','/images/brands/blu-gas.png',30,'2026-10-01 16:53:46');
INSERT INTO brands VALUES(4,'petron','Petron','#004E9C','#FFD100','petron','/images/brands/petron.png',40,'2026-10-01 16:53:46');
INSERT INTO brands VALUES(5,'seaoil','Seaoil','#FEF201','#030315','seaoil','/images/brands/seaoil.png',50,'2026-10-01 16:53:46');
INSERT INTO brands VALUES(6,'c-oil','C-Oil','#0E7A3C','#C8102E','c-oil','/images/brands/c-oil.png',60,'2026-10-01 16:53:46');
INSERT INTO brands VALUES(7,'phoenix','Phoenix','#DC291E','#FFFE00','phoenix','/images/brands/phoenix.png',70,'2026-10-01 16:53:46');
INSERT INTO stations VALUES(1,1,'Shell','Torrijos Street, Zone 5, Bangued, Abra','Zone 5',17.59200799999999987,120.6185509999999966,NULL,NULL,NULL,NULL,0,1,'confirmed','node/3093489524','2026-10-01 16:53:46','2026-10-01 17:29:32');
INSERT INTO stations VALUES(2,2,'Caltex (Power V Caltex Service Station)','Brgy. Lipcan, Bangued, Abra','Lipcan',17.57982300000000108,120.617873000000003,NULL,NULL,NULL,'APPROXIMATE POSITION - please verify. Coordinates are the OSM centroid of the Lipcan village node (node/12949328477), not a surveyed station location. Unverified lead: OSM also lists a "Caltex" fuel station inside Bangued at 17.5941151, 120.6193520 (node/3093476663), roughly 1.6 km north of the Lipcan centroid. Confirm which one is Power V Caltex and set the final coordinates here.',0,1,'confirmed','node/12949328477','2026-10-01 16:53:46','2026-10-01 17:10:31');
INSERT INTO stations VALUES(3,3,'Blu Gas Station #1','HJQ8+PXH, Ilocos Sur - Abra Rd, Bangued, Abra','Ubbog, Lipcan',17.58946200000000104,120.6175089999999984,NULL,NULL,'24 hours','Awaiting confirmation of address and coordinates from the project owner.',0,1,'confirmed',NULL,'2026-10-01 16:53:46','2026-10-01 17:20:56');
INSERT INTO stations VALUES(4,3,'Blu Gas Station #2','Zone 5, Pob. (Bo. Barikir, Bangued, Abra)','Zone 5',17.59638893357400135,120.6197631009199966,NULL,NULL,'24 hours','Awaiting confirmation of address and coordinates from the project owner.',0,1,'confirmed',NULL,'2026-10-01 16:53:46','2026-10-01 17:22:05');
INSERT INTO stations VALUES(5,4,'Petron','JJ2C+H45, Ilocos Norte - Abra Rd, Bangued, Abra','Zone 1',17.60137277298499825,120.6203304603599946,NULL,NULL,'7:30 - 6:00','Awaiting confirmation of address and coordinates from the project owner. Unverified lead: OSM lists a "Petron" fuel station inside Bangued at 17.5836385, 120.6172101 (node/4525780866) - confirm before using.',0,1,'confirmed','node/4525780866','2026-10-01 16:53:46','2026-10-01 17:11:55');
INSERT INTO stations VALUES(6,5,'Seaoil #1','Rizal St, Zone 7, Bangued, 2800 Abra','Zone 7',17.60059499999999843,120.6228619999999979,NULL,NULL,NULL,NULL,0,1,'confirmed',NULL,'2026-10-01 16:53:46','2026-10-01 21:15:47');
INSERT INTO stations VALUES(7,6,'C-Oil','HJM8+WXJ, Ilocos Sur - Abra Rd, Bangued, Abra','Ubbog Lipcan',17.58500099999999832,120.6173969999999969,NULL,NULL,'12','Awaiting coordinates from the project owner. Until they are filled in this station stays off the public map as a placeholder; the logo file is still to be supplied as well.',0,1,'confirmed',NULL,'2026-10-01 16:53:46','2026-10-01 17:10:18');
INSERT INTO stations VALUES(8,7,'Phoenix','JJ4Q+7W8, Bangued, Abra','Macray',17.60714000000000112,120.640191999999999,NULL,NULL,'7:30 - 6:00','Awaiting coordinates from the project owner. The logo is already in place, so only the coordinates are outstanding before this station goes live.',0,1,'confirmed',NULL,'2026-10-01 16:53:46','2026-10-01 17:10:24');
INSERT INTO stations VALUES(9,4,'Petron','Ilocos Sur - Abra Rd, Bangued, Abra','Lipcan',17.58386775107199896,120.6172153696799967,NULL,NULL,'24',NULL,0,1,'confirmed',NULL,'2026-10-01 17:09:27','2026-10-01 17:16:18');
INSERT INTO stations VALUES(10,2,'Caltex (AFM Platinum Gas Station)','HJV9+JPM, Taft Ave, Bangued, Abra','Zone 5',17.5941200000000002,120.6193360000000041,NULL,NULL,'7:30 - 8:30',NULL,0,1,'confirmed',NULL,'2026-10-01 17:26:01','2026-10-01 21:15:30');
INSERT INTO fuel_prices VALUES(1,1,'Diesel',105.2000000000000028,'2026-10-01 21:20:31','2026-10-01 21:20:31');
INSERT INTO fuel_prices VALUES(2,1,'Gasoline',9.40000000000000035,'2026-10-01 21:20:31','2026-10-01 21:20:31');
INSERT INTO fuel_prices VALUES(3,1,'V-Power Diesel',110.5999999999999944,'2026-10-01 21:20:31','2026-10-01 21:20:31');
INSERT INTO fuel_prices VALUES(4,1,'V-Power Gasoline',93.5999999999999944,'2026-10-01 21:20:31','2026-10-01 21:20:31');
INSERT INTO fuel_prices VALUES(5,10,'Diesel',104.0,'2026-10-01 17:42:07','2026-10-01 17:42:07');
INSERT INTO fuel_prices VALUES(6,10,'Platinum',91.5,'2026-10-01 17:42:07','2026-10-01 17:42:07');
INSERT INTO fuel_prices VALUES(7,10,'Silver',90.5,'2026-10-01 17:42:07','2026-10-01 17:42:07');
INSERT INTO fuel_prices VALUES(8,2,'Diesel',104.5,'2026-10-01 17:42:00','2026-10-01 17:43:26');
INSERT INTO fuel_prices VALUES(9,2,'Platinum',91.5,'2026-10-01 17:42:00','2026-10-01 17:43:26');
INSERT INTO fuel_prices VALUES(10,2,'Silver',90.5,'2026-10-01 17:42:00','2026-10-01 17:43:26');
INSERT INTO fuel_prices VALUES(11,3,'Diesel',83.0,'2026-10-01 17:43:00','2026-10-01 17:45:06');
INSERT INTO fuel_prices VALUES(12,3,'Premium Gasoline',91.45000000000000284,'2026-10-01 17:43:00','2026-10-01 17:45:06');
INSERT INTO fuel_prices VALUES(13,3,'Super Premium',95.5,'2026-10-01 17:43:00','2026-10-01 17:45:06');
INSERT INTO fuel_prices VALUES(14,3,'Unleaded',90.45000000000000284,'2026-10-01 17:43:00','2026-10-01 17:45:06');
INSERT INTO fuel_prices VALUES(28,4,'Diesel',103.0,'2026-10-02 01:07:23','2026-10-02 01:07:23');
INSERT INTO fuel_prices VALUES(29,4,'Premium',91.45000000000000284,'2026-10-02 01:07:23','2026-10-02 01:07:23');
INSERT INTO fuel_prices VALUES(30,4,'Unleaded',90.45000000000000284,'2026-10-02 01:07:23','2026-10-02 01:07:23');
INSERT INTO fuel_prices VALUES(31,5,'Diesel Max',103.0,'2026-10-02 01:33:39','2026-10-02 01:33:39');
INSERT INTO fuel_prices VALUES(32,5,'XCS',91.5,'2026-10-02 01:33:39','2026-10-02 01:33:39');
INSERT INTO fuel_prices VALUES(33,5,'Xtra Advance',90.5,'2026-10-02 01:33:39','2026-10-02 01:33:39');
INSERT INTO fuel_prices VALUES(34,9,'Diesel Max',103.0,'2026-10-02 01:34:46','2026-10-02 01:34:46');
INSERT INTO fuel_prices VALUES(35,9,'XCS',91.5,'2026-10-02 01:34:46','2026-10-02 01:34:46');
INSERT INTO fuel_prices VALUES(36,9,'Xtra Advance',90.45000000000000284,'2026-10-02 01:34:46','2026-10-02 01:34:46');
INSERT INTO fuel_prices VALUES(37,6,'Exceed Diesel',103.0,'2026-10-02 01:36:28','2026-10-02 01:36:28');
INSERT INTO fuel_prices VALUES(38,6,'Extreme 95',91.5,'2026-10-02 01:36:28','2026-10-02 01:36:28');
INSERT INTO fuel_prices VALUES(39,6,'Extreme U',90.5,'2026-10-02 01:36:28','2026-10-02 01:36:28');
INSERT INTO fuel_price_history VALUES(1,1,'Diesel',NULL,105.2000000000000028,'2026-10-01 17:32:40','admin');
INSERT INTO fuel_price_history VALUES(2,1,'Gasoline',NULL,9.40000000000000035,'2026-10-01 17:32:40','admin');
INSERT INTO fuel_price_history VALUES(3,1,'V-Power Diesel',NULL,110.5999999999999944,'2026-10-01 17:32:40','admin');
INSERT INTO fuel_price_history VALUES(4,1,'V-Power Gasoline',NULL,93.7000000000000028,'2026-10-01 17:32:40','admin');
INSERT INTO fuel_price_history VALUES(5,1,'V-Power Gasoline',93.7000000000000028,93.5999999999999944,'2026-10-01 17:40:53','admin');
INSERT INTO fuel_price_history VALUES(6,10,'Diesel',NULL,104.0,'2026-10-01 17:42:07','admin');
INSERT INTO fuel_price_history VALUES(7,10,'Platinum',NULL,91.5,'2026-10-01 17:42:07','admin');
INSERT INTO fuel_price_history VALUES(8,10,'Silver',NULL,90.5,'2026-10-01 17:42:07','admin');
INSERT INTO fuel_price_history VALUES(9,2,'Diesel',NULL,104.5,'2026-10-01 17:43:26','admin');
INSERT INTO fuel_price_history VALUES(10,2,'Platinum',NULL,91.5,'2026-10-01 17:43:26','admin');
INSERT INTO fuel_price_history VALUES(11,2,'Silver',NULL,90.5,'2026-10-01 17:43:26','admin');
INSERT INTO fuel_price_history VALUES(12,3,'Diesel',NULL,83.0,'2026-10-01 17:45:06','admin');
INSERT INTO fuel_price_history VALUES(13,3,'Premium Gasoline',NULL,91.45000000000000284,'2026-10-01 17:45:06','admin');
INSERT INTO fuel_price_history VALUES(14,3,'Super Premium',NULL,95.5,'2026-10-01 17:45:06','admin');
INSERT INTO fuel_price_history VALUES(15,3,'Unleaded',NULL,90.45000000000000284,'2026-10-01 17:45:06','admin');
INSERT INTO fuel_price_history VALUES(29,4,'Diesel',NULL,103.0,'2026-10-02 01:06:42','admin');
INSERT INTO fuel_price_history VALUES(30,4,'Premium',NULL,91.45000000000000284,'2026-10-02 01:07:23','admin');
INSERT INTO fuel_price_history VALUES(31,4,'Unleaded',NULL,90.45000000000000284,'2026-10-02 01:07:23','admin');
INSERT INTO fuel_price_history VALUES(32,5,'Diesel Max',NULL,103.0,'2026-10-02 01:33:39','admin');
INSERT INTO fuel_price_history VALUES(33,5,'XCS',NULL,91.5,'2026-10-02 01:33:39','admin');
INSERT INTO fuel_price_history VALUES(34,5,'Xtra Advance',NULL,90.5,'2026-10-02 01:33:39','admin');
INSERT INTO fuel_price_history VALUES(35,9,'Diesel Max',NULL,103.0,'2026-10-02 01:34:46','admin');
INSERT INTO fuel_price_history VALUES(36,9,'XCS',NULL,91.5,'2026-10-02 01:34:46','admin');
INSERT INTO fuel_price_history VALUES(37,9,'Xtra Advance',NULL,90.45000000000000284,'2026-10-02 01:34:46','admin');
INSERT INTO fuel_price_history VALUES(38,6,'Exceed Diesel',NULL,103.0,'2026-10-02 01:36:28','admin');
INSERT INTO fuel_price_history VALUES(39,6,'Extreme 95',NULL,91.5,'2026-10-02 01:36:28','admin');
INSERT INTO fuel_price_history VALUES(40,6,'Extreme U',NULL,90.5,'2026-10-02 01:36:28','admin');

SET FOREIGN_KEY_CHECKS = 1;

