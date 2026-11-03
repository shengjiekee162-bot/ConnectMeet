-- ConnectMeet database schema
-- Compatible with MySQL 8.0+ / MariaDB 10.5+

CREATE DATABASE IF NOT EXISTS connectmeet
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE connectmeet;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS signaling_messages;
DROP TABLE IF EXISTS meeting_events;
DROP TABLE IF EXISTS meeting_messages;
DROP TABLE IF EXISTS meeting_invitations;
DROP TABLE IF EXISTS meeting_participants;
DROP TABLE IF EXISTS meetings;
DROP TABLE IF EXISTS rate_limits;
DROP TABLE IF EXISTS app_settings;
DROP TABLE IF EXISTS users;

SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  display_name VARCHAR(80) NOT NULL,
  email VARCHAR(191) NULL UNIQUE,
  password_hash VARCHAR(255) NULL,
  role ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meetings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_code VARCHAR(32) NOT NULL,
  host_user_id BIGINT UNSIGNED NULL,
  host_token_hash CHAR(64) NOT NULL,
  title VARCHAR(160) NOT NULL DEFAULT 'ConnectMeet Meeting',
  status ENUM('scheduled', 'active', 'ended', 'expired') NOT NULL DEFAULT 'active',
  scheduled_at DATETIME NULL,
  expires_at DATETIME NULL,
  is_locked TINYINT(1) NOT NULL DEFAULT 0,
  waiting_room_enabled TINYINT(1) NOT NULL DEFAULT 0,
  participant_limit INT UNSIGNED NOT NULL DEFAULT 8,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_meetings_code (meeting_code),
  KEY idx_meetings_status (status),
  KEY idx_meetings_expires (expires_at),
  KEY idx_meetings_host_user (host_user_id),
  CONSTRAINT fk_meetings_host_user FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_participants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  participant_token_hash CHAR(64) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  role ENUM('host', 'participant') NOT NULL DEFAULT 'participant',
  audio_enabled TINYINT(1) NOT NULL DEFAULT 1,
  video_enabled TINYINT(1) NOT NULL DEFAULT 1,
  screen_sharing TINYINT(1) NOT NULL DEFAULT 0,
  hand_raised TINYINT(1) NOT NULL DEFAULT 0,
  connection_state VARCHAR(32) NOT NULL DEFAULT 'joining',
  is_admitted TINYINT(1) NOT NULL DEFAULT 1,
  joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_participant_token (participant_token_hash),
  KEY idx_participants_meeting (meeting_id),
  KEY idx_participants_active (meeting_id, left_at, last_seen_at),
  KEY idx_participants_user (user_id),
  CONSTRAINT fk_participants_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_participants_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  participant_id BIGINT UNSIGNED NOT NULL,
  message_type ENUM('text', 'system') NOT NULL DEFAULT 'text',
  message_content VARCHAR(1000) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_messages_meeting_created (meeting_id, id),
  CONSTRAINT fk_messages_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_participant FOREIGN KEY (participant_id) REFERENCES meeting_participants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  participant_id BIGINT UNSIGNED NULL,
  event_type VARCHAR(64) NOT NULL,
  event_payload JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_meeting_id (meeting_id, id),
  KEY idx_events_type (meeting_id, event_type),
  CONSTRAINT fk_events_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_events_participant FOREIGN KEY (participant_id) REFERENCES meeting_participants(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE signaling_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  from_participant_id BIGINT UNSIGNED NOT NULL,
  to_participant_id BIGINT UNSIGNED NOT NULL,
  signal_type ENUM('offer', 'answer', 'ice-candidate', 'renegotiate') NOT NULL,
  payload MEDIUMTEXT NOT NULL,
  delivered TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_signaling_inbox (to_participant_id, delivered, id),
  KEY idx_signaling_meeting (meeting_id, created_at),
  CONSTRAINT fk_signaling_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
  CONSTRAINT fk_signaling_from FOREIGN KEY (from_participant_id) REFERENCES meeting_participants(id) ON DELETE CASCADE,
  CONSTRAINT fk_signaling_to FOREIGN KEY (to_participant_id) REFERENCES meeting_participants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE meeting_invitations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  meeting_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invitation_token (token_hash),
  KEY idx_invitations_meeting (meeting_id),
  CONSTRAINT fk_invitations_meeting FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rate_limits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rate_key VARCHAR(128) NOT NULL,
  hits INT UNSIGNED NOT NULL DEFAULT 1,
  window_start DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rate_key (rate_key),
  KEY idx_rate_window (window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_settings (
  setting_key VARCHAR(64) NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('app_name', 'ConnectMeet'),
  ('schema_version', '1.0.0');
