#!/bin/bash

# Alle Ausgaben (stdout+stderr) in Logdatei neben dem Script speichern
LOG_FILE="$(dirname "$(realpath "$0")")/install.log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== Installationslog wird geschrieben nach: $LOG_FILE ==="


echo "=== ViciDial Installation auf Debian 12 - Ohne CyburPhone, Dynportal, Firewall-Automatik ==="

# Funktion für Benutzereingabe
prompt() {
    local varname=$1
    local prompt_text=$2
    local default_value=$3
    read -p "$prompt_text [$default_value]: " input
    export $varname="${input:-$default_value}"
}

echo "Systeminformationen werden ermittelt - Kein Hostname? Bitte IP-Adresse eingeben"
echo "**************************************************************************"
prompt hostname "Hostname eingeben:" "$(hostname)"
echo "Enter drücken zum Fortfahren"
read
hostnamectl set-hostname "$hostname"
hostname=$(hostname | awk '{print $1}')
echo "Hostname\t: $hostname"
ip_address=$(hostname -I | awk '{print $1}')
echo "IP-Adresse\t: $ip_address"
echo "**************************************************************************"
echo "Enter zum Fortfahren..."
read

export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

# Systemupdate
apt-get update -y
apt-get upgrade -y

# Build-Werkzeuge (entspricht "Development Tools")
# bsdutils (logger) und python3-pip hinzugefügt
apt-get install -y build-essential git subversion curl wget unzip nano htop atop iftop \
    gcc g++ make patch bsdutils python3-pip

# PHP 7.4 via sury.org (Debian 12 hat standardmäßig PHP 8.2)
apt-get install -y lsb-release ca-certificates apt-transport-https gnupg2
curl -sSLo /usr/share/keyrings/deb.sury.org-php.gpg https://packages.sury.org/php/apt.gpg
echo "deb [signed-by=/usr/share/keyrings/deb.sury.org-php.gpg] https://packages.sury.org/php/ $(lsb_release -sc) main" \
    > /etc/apt/sources.list.d/php.list
apt-get update -y

# PHP 7.4 Pakete
apt-get install -y \
    php7.4 php7.4-cli php7.4-gd php7.4-curl php7.4-mysql php7.4-ldap \
    php7.4-zip php7.4-mbstring php7.4-xml php7.4-xmlrpc php7.4-imap \
    php7.4-opcache php7.4-bcmath php7.4-intl php7.4-readline

# Apache und MariaDB
apt-get install -y apache2 libapache2-mod-php7.4
apt-get install -y mariadb-server mariadb-client

# Weitere Abhängigkeiten
# libcpan-perl und libenv-perl existieren nicht in Debian 12, daher entfernt.
# liblame-dev existiert nicht, durch libmp3lame-dev ersetzt.
# sendmail entfernt (Konflikt mit postfix), nur postfix behalten.
apt-get install -y \
    libreadline-dev libxml2-dev libsqlite3-dev libuuid1 uuid-dev \
    libcurl4-openssl-dev libgd-dev libssl-dev libnewt-dev \
    libspeex-dev libspeexdsp-dev sox lame libmp3lame-dev \
    postfix s-nail imagemagick sngrep dnsutils \
    screen pv inxi elfutils libelf-dev \
    libedit-dev libsrtp2-dev

# Perl Module (libcpan-perl und libenv-perl als Systempakete nicht verfügbar,
# werden bei Bedarf später über cpan installiert – für ViciDial i.d.R. aber nicht nötig)
apt-get install -y \
    perl libdbi-perl libdbd-mysql-perl \
    libgd-perl libwww-perl libterm-readline-gnu-perl \
    libnet-telnet-perl \
    libyaml-perl

# PHP konfigurieren
PHP_INI=$(php7.4 --ini | grep "Loaded Configuration" | awk '{print $NF}')
# php.ini für CLI
for ini_file in /etc/php/7.4/apache2/php.ini /etc/php/7.4/cli/php.ini; do
    [ -f "$ini_file" ] || continue
    sed -i 's/^error_reporting.*/error_reporting = E_ALL \& ~E_NOTICE/' "$ini_file"
    sed -i 's/^memory_limit.*/memory_limit = 448M/' "$ini_file"
    sed -i 's/^short_open_tag.*/short_open_tag = On/' "$ini_file"
    sed -i 's/^max_execution_time.*/max_execution_time = 3330/' "$ini_file"
    sed -i 's/^max_input_time.*/max_input_time = 3360/' "$ini_file"
    sed -i 's/^post_max_size.*/post_max_size = 448M/' "$ini_file"
    sed -i 's/^upload_max_filesize.*/upload_max_filesize = 442M/' "$ini_file"
    sed -i 's/^default_socket_timeout.*/default_socket_timeout = 3360/' "$ini_file"
    sed -i 's|^;date.timezone.*|date.timezone = America/New_York|' "$ini_file"
    # max_input_vars hinzufügen wenn nicht vorhanden
    grep -q 'max_input_vars' "$ini_file" || echo "max_input_vars = 50000" >> "$ini_file"
done

# Apache MPM Fix für PHP 7.4 (Prefork erforderlich)
a2dismod mpm_event 2>/dev/null || true
a2dismod mpm_worker 2>/dev/null || true
a2enmod mpm_prefork 2>/dev/null || true

# Apache aktivieren
a2enmod php7.4 rewrite ssl
systemctl enable apache2
systemctl restart apache2

# SSH Root-Login erlauben (wie im Original)
sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config
systemctl restart ssh

# MariaDB konfigurieren
cp /etc/mysql/mariadb.conf.d/50-server.cnf /etc/mysql/mariadb.conf.d/50-server.cnf.original

cat > /etc/mysql/mariadb.conf.d/60-vicidial.cnf <<MYSQLCONF
[mysql.server]
user = mysql

[client]
port = 3306
socket = /var/run/mysqld/mysqld.sock

[mysqld]
datadir = /var/lib/mysql
socket = /var/run/mysqld/mysqld.sock
user = mysql
old_passwords = 0
ft_min_word_len = 3
max_connections = 800
max_allowed_packet = 32M
skip-external-locking
sql_mode = "NO_ENGINE_SUBSTITUTION"

general_log_file = /var/log/mysql/mysql.log
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow-queries.log
long_query_time = 1

query_cache_type = 1
query_cache_size = 32M
tmp_table_size = 128M
table_open_cache = 1024
join_buffer_size = 1M
key_buffer_size = 512M
sort_buffer_size = 6M
read_buffer_size = 4M
read_rnd_buffer_size = 16M
myisam_sort_buffer_size = 64M
max_tmp_tables = 64
thread_cache_size = 8

[mysqldump]
quick
max_allowed_packet = 16M

[mysql]
no-auto-rehash

[isamchk]
key_buffer = 256M
sort_buffer_size = 256M
read_buffer = 2M
write_buffer = 2M

[myisamchk]
key_buffer = 256M
sort_buffer_size = 256M
read_buffer = 2M
write_buffer = 2M

[mysqlhotcopy]
interactive-timeout
MYSQLCONF

mkdir -p /var/log/mysql
touch /var/log/mysql/slow-queries.log
chown -R mysql:mysql /var/log/mysql

systemctl enable mariadb
systemctl restart mariadb

# Warte, bis MariaDB wirklich läuft
echo "Warte auf MariaDB..."
for i in $(seq 1 30); do
    if mysqladmin ping &>/dev/null; then
        echo "MariaDB ist bereit."
        break
    fi
    sleep 2
done
if ! mysqladmin ping &>/dev/null; then
    echo "FEHLER: MariaDB konnte nicht gestartet werden. Bitte manuell prüfen."
    exit 1
fi

# Asterisk Perl Modul
cd /usr/src
wget http://download.vicidial.com/required-apps/asterisk-perl-0.08.tar.gz
tar xzf asterisk-perl-0.08.tar.gz
cd asterisk-perl-0.08
perl Makefile.PL
make all
make install

# Lame
cd /usr/src
wget http://downloads.sourceforge.net/project/lame/lame/3.99/lame-3.99.5.tar.gz
tar -zxf lame-3.99.5.tar.gz
cd lame-3.99.5
./configure
make
make install

# Jansson
cd /usr/src/
wget https://digip.org/jansson/releases/jansson-2.13.tar.gz
tar xvzf jansson-2.13.tar.gz
cd jansson-2.13
./configure
make clean
make
make install
ldconfig

# DAHDI
echo "DAHDI wird installiert..."
apt-get install -y linux-headers-$(uname -r) dahdi-linux dahdi-source

# Falls apt-Paket nicht verfügbar: aus Source bauen
if ! command -v dahdi_cfg &>/dev/null; then
    cd /usr/src/
    mkdir dahdi-linux-complete-3.4.0+3.4.0
    cd dahdi-linux-complete-3.4.0+3.4.0
    wget https://cybur-dial.com/dahdi-9.5-fix.zip
    unzip dahdi-9.5-fix.zip
    make clean
    make
    make install
    make install-config
    cd tools
    make clean
    make
    make install
    make install-config
fi

cp /etc/dahdi/system.conf.sample /etc/dahdi/system.conf 2>/dev/null || true
modprobe dahdi 2>/dev/null || true
modprobe dahdi_dummy 2>/dev/null || true
dahdi_cfg -vvvvvvvvvvvvv 2>/dev/null || true
systemctl enable dahdi 2>/dev/null || true
service dahdi start 2>/dev/null || true

# libsrtp 2.1.0
cd /usr/src
wget https://github.com/cisco/libsrtp/archive/v2.1.0.tar.gz -O libsrtp-2.1.0.tar.gz
tar xfv libsrtp-2.1.0.tar.gz
cd libsrtp-2.1.0
./configure --prefix=/usr --enable-openssl
make shared_library && make install
ldconfig

# LibPRI + Asterisk 18 (ViciDial-Variante) - beide im selben Verzeichnis wie Original
mkdir -p /usr/src/asterisk
cd /usr/src/asterisk
wget https://downloads.asterisk.org/pub/telephony/libpri/libpri-1.6.1.tar.gz
wget https://download.vicidial.com/required-apps/asterisk-18.21.0-vici.tar.gz
tar -xvzf libpri-1.6.1.tar.gz
tar -xvzf asterisk-18.21.0-vici.tar.gz

# LibPRI zuerst bauen und installieren
cd /usr/src/asterisk/libpri-1.6.1
make
make install

# Jetzt Asterisk
cd /usr/src/asterisk/asterisk-18.21.0-vici

# Asterisk Abhängigkeiten via contrib-Skript
# libpjproject-dev gibt es in Debian 12 nicht; wird via --with-pjproject-bundled abgedeckt -> entfernt
apt-get install -y libjansson-dev libxml2-dev libnewt-dev libsqlite3-dev \
    libuuid1 uuid-dev libcurl4-openssl-dev libedit-dev \
    liblua5.2-dev libspeex-dev libspeexdsp-dev libogg-dev libvorbis-dev \
    libresample1-dev libxslt1-dev libssl-dev libavcodec-dev unixodbc-dev

: ${JOBS:=$(( $(nproc) + $(nproc) / 2 ))}
./configure --libdir=/usr/lib/x86_64-linux-gnu \
    --with-gsm=internal \
    --enable-opus \
    --enable-srtp \
    --with-ssl \
    --enable-asteriskssl \
    --with-pjproject-bundled \
    --with-jansson-bundled

make menuselect/menuselect menuselect-tree menuselect.makeopts
menuselect/menuselect --enable app_meetme menuselect.makeopts
menuselect/menuselect --enable res_http_websocket menuselect.makeopts
menuselect/menuselect --enable res_srtp menuselect.makeopts

mkdir -p /var/lib/asterisk/phoneprov
make samples
sed -i 's|noload = chan_sip.so|;noload = chan_sip.so|g' /etc/asterisk/modules.conf 2>/dev/null || true
make -j ${JOBS} all
make install

# astguiclient via SVN
echo "astguiclient wird aus SVN installiert..."
apt-get install -y subversion
mkdir -p /usr/src/astguiclient
cd /usr/src/astguiclient
svn checkout svn://svn.eflo.net/agc_2-X/trunk
cd /usr/src/astguiclient/trunk

# Datenbank einrichten
echo "Datenbank wird eingerichtet..."
mysql -u root << MYSQLCREOF
CREATE DATABASE asterisk DEFAULT CHARACTER SET utf8 COLLATE utf8_unicode_ci;
CREATE USER 'cron'@'localhost' IDENTIFIED BY '1234';
GRANT SELECT,CREATE,ALTER,INSERT,UPDATE,DELETE,LOCK TABLES on asterisk.* TO cron@'%' IDENTIFIED BY '1234';
GRANT SELECT,CREATE,ALTER,INSERT,UPDATE,DELETE,LOCK TABLES on asterisk.* TO cron@localhost IDENTIFIED BY '1234';
GRANT RELOAD ON *.* TO cron@'%';
GRANT RELOAD ON *.* TO cron@localhost;
CREATE USER 'custom'@'localhost' IDENTIFIED BY 'custom1234';
GRANT SELECT,CREATE,ALTER,INSERT,UPDATE,DELETE,LOCK TABLES on asterisk.* TO custom@'%' IDENTIFIED BY 'custom1234';
GRANT SELECT,CREATE,ALTER,INSERT,UPDATE,DELETE,LOCK TABLES on asterisk.* TO custom@localhost IDENTIFIED BY 'custom1234';
GRANT RELOAD ON *.* TO custom@'%';
GRANT RELOAD ON *.* TO custom@localhost;
flush privileges;
SET GLOBAL connect_timeout=60;
use asterisk;
\. /usr/src/astguiclient/trunk/extras/MySQL_AST_CREATE_tables.sql
\. /usr/src/astguiclient/trunk/extras/first_server_install.sql
update servers set asterisk_version='18.21.1-vici';
quit
MYSQLCREOF

# astguiclient.conf
cat > /etc/astguiclient.conf <<ASTGUI
# astguiclient.conf
PATHhome => /usr/share/astguiclient
PATHlogs => /var/log/astguiclient
PATHagi => /var/lib/asterisk/agi-bin
PATHweb => /var/www/html
PATHsounds => /var/lib/asterisk/sounds
PATHmonitor => /var/spool/asterisk/monitor
PATHDONEmonitor => /var/spool/asterisk/monitorDONE
VARserver_ip => $ip_address
VARDB_server => localhost
VARDB_database => asterisk
VARDB_user => cron
VARDB_pass => 1234
VARDB_custom_user => custom
VARDB_custom_pass => custom1234
VARDB_port => 3306
VARactive_keepalives => 12345689EC
VARasterisk_version => 18.X
VARFTP_host => 10.0.0.4
VARFTP_user => cron
VARFTP_pass => test
VARFTP_port => 21
VARFTP_dir => RECORDINGS
VARHTTP_path => http://10.0.0.4
VARREPORT_host => 10.0.0.4
VARREPORT_user => cron
VARREPORT_pass => test
VARREPORT_port => 21
VARREPORT_dir => REPORTS
VARfastagi_log_min_servers => 3
VARfastagi_log_max_servers => 16
VARfastagi_log_min_spare_servers => 2
VARfastagi_log_max_spare_servers => 8
VARfastagi_log_max_requests => 1000
VARfastagi_log_checkfordead => 30
VARfastagi_log_checkforwait => 60
ExpectedDBSchema => 1720
ASTGUI

# ViciDial installieren
cd /usr/src/astguiclient/trunk
perl install.pl --no-prompt --copy_sample_conf_files=Y

# Manager auf localhost beschränken
sed -i 's/0.0.0.0/127.0.0.1/g' /etc/asterisk/manager.conf

# Module-Deaktivierungen
cat >> /etc/asterisk/modules.conf <<EOF
noload => res_timing_timerfd.so
noload => res_timing_kqueue.so
noload => res_timing_pthread.so
EOF

# Logger: verbose-Meldungen auch in der Konsole anzeigen
sed -i 's/console => notice,warning,error,dtmf/console => notice,warning,error,verbose,dtmf/' /etc/asterisk/logger.conf

# Area Codes befüllen
/usr/share/astguiclient/ADMIN_area_code_populate.pl

# Server-IP aktualisieren
/usr/share/astguiclient/ADMIN_update_server_ip.pl --old-server_ip=10.10.10.15 --server_ip=$ip_address --auto

perl install.pl --no-prompt

# Crontab
cat > /root/crontab-file <<CRONTAB
### keepalive script for astguiclient processes
* * * * * /usr/share/astguiclient/ADMIN_keepalive_ALL.pl

### Compress astguiclient log files and remove old ones
25 2 * * * /usr/bin/find /var/log/astguiclient -maxdepth 1 -type f -mtime +1 -print | grep -v \.xz | xargs xz -9 >/dev/null 2>&1
28 0 * * * /usr/bin/find /var/log/astguiclient -maxdepth 1 -type f -mtime +30 -print | xargs rm -f

### fix the vicidial_agent_log once every hour and the full day run at night
33 * * * * /usr/share/astguiclient/AST_cleanup_agent_log.pl
50 0 * * * /usr/share/astguiclient/AST_cleanup_agent_log.pl --last-24hours

### updater for VICIDIAL hopper
* * * * * /usr/share/astguiclient/AST_VDhopper.pl -q

### adjust the GMT offset for the leads in the vicidial_list table
1 1,7 * * * /usr/share/astguiclient/ADMIN_adjust_GMTnow_on_leads.pl --debug --list-settings

### optimize the database tables within the asterisk database
3 1 * * * /usr/share/astguiclient/AST_DB_optimize.pl

### VICIDIAL agent time log weekly and daily summary report generation
2 0 * * 0 /usr/share/astguiclient/AST_agent_week.pl
22 0 * * * /usr/share/astguiclient/AST_agent_day.pl

### VICIDIAL campaign export scripts (OPTIONAL)
#32 0 * * * /usr/share/astguiclient/AST_VDsales_export.pl
#42 0 * * * /usr/share/astguiclient/AST_sourceID_summary_export.pl

### inventory report optional
#1 7 * * * /usr/share/astguiclient/AST_dialer_inventory_snapshot.pl -q --override-24hours

### roll logs monthly on high-volume dialing systems
#30 1 1 * * /usr/share/astguiclient/ADMIN_archive_log_tables.pl --months=6

### roll call_log and vicidial_log_extended daily on very high-volume dialing systems
#20 1 * * * /usr/share/astguiclient/ADMIN_archive_log_tables.pl --daily

## uncomment below if using Vtiger
#1 1 * * * /usr/share/astguiclient/Vtiger_optimize_all_tables.pl --quiet

# cleanup of the scheduled callback records
25 0 * * * /usr/share/astguiclient/AST_DB_dead_cb_purge.pl --purge-non-cb --quiet

### inbound email parser should only be active on a single server
* * * * * /usr/share/astguiclient/AST_inbound_email_parser.pl

### flush queue DB table every hour for entries older than 1 hour
11 * * * * /usr/share/astguiclient/AST_flush_DBqueue.pl -q

### remove and rotate old asterisk logs
29 0 * * * /usr/bin/find /var/log/asterisk -maxdepth 3 -type f -mtime +30 -print | xargs rm -f
30 0 * * * /usr/bin/find / -maxdepth 1 -name "screenlog.0*" -mtime +7 -print | xargs rm -f
31 0 * * * /usr/bin/find /tmp -maxdepth 1 -type f -mtime +7 -print | xargs rm -f
32 0 * * * /usr/bin/find /var/log/asterisk -maxdepth 1 -type f -mtime +1 -print | grep -v \.xz | xargs xz >/dev/null 2>&1

### recording mixing/compressing/ftping scripts
0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57 * * * * /usr/share/astguiclient/AST_CRON_audio_1_move_mix.pl --MIX
0,3,6,9,12,15,18,21,24,27,30,33,36,39,42,45,48,51,54,57 * * * * /usr/share/astguiclient/AST_CRON_audio_1_move_VDonly.pl
1,4,7,10,13,16,19,22,25,28,31,34,37,40,43,46,49,52,55,58 * * * * /usr/share/astguiclient/AST_CRON_audio_2_compress.pl --MP3

### remove old recordings more than 7 days old, and delete originals after 1 day
24 1 * * * /usr/bin/find /var/spool/asterisk/monitorDONE/ORIG -maxdepth 2 -type f -mtime +1 -print | xargs rm -f

### kill Hangup script for Asterisk updaters
* * * * * /usr/share/astguiclient/AST_manager_kill_hung_congested.pl

### updater for voicemail
* * * * * /usr/share/astguiclient/AST_vm_update.pl

### updater for conference validator
* * * * * /usr/share/astguiclient/AST_conf_update.pl

### reset several temporary-info tables in the database
2 1 * * * /usr/share/astguiclient/AST_reset_mysql_vars.pl

### Reboot nightly to manage asterisk issues and memory leaks - uncomment if issues arise
#30 6 * * * /sbin/reboot

### remove text to speech file more than 4 days old
#20 0 * * * /usr/bin/find /var/lib/asterisk/sounds/tts/ -maxdepth 2 -type f -mtime +4 -print | xargs rm -f

### clean up stale ASTemail screen sessions (zombies after DB connection loss)
*/30 * * * * screen -ls 2>/dev/null | grep ASTemail | awk '{print \$1}' | cut -d. -f1 | xargs -r kill 2>/dev/null; screen -wipe 2>/dev/null
CRONTAB

crontab /root/crontab-file

# Asterisk Systemd Service (in Screen-Session, damit VICIdial-Admin-Befehle funktionieren)
cat > /etc/systemd/system/asterisk.service <<EOF
[Unit]
Description=Asterisk PBX
Wants=nss-lookup.target network-online.target
After=network-online.target

[Service]
ExecStart=/usr/bin/screen -dmS asterisk /usr/sbin/asterisk -gc -vvvv
ExecStop=/usr/bin/screen -S asterisk -X quit
Restart=always
Type=forking

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable asterisk

# rc.local (Debian 12 Äquivalent)
cat > /etc/rc.local <<EOF
#!/bin/bash
systemctl start mariadb.service
systemctl start apache2.service
/usr/share/astguiclient/ADMIN_restart_roll_logs.pl
/usr/share/astguiclient/AST_reset_mysql_vars.pl
modprobe dahdi 2>/dev/null || true
modprobe dahdi_dummy 2>/dev/null || true
dahdi_cfg -vvvvvvvvvvvvv 2>/dev/null || true
sleep 20
/usr/share/astguiclient/start_asterisk_boot.pl
exit 0
EOF

chmod +x /etc/rc.local
# rc.local als Service aktivieren (Debian 12)
cat > /etc/systemd/system/rc-local.service <<EOF
[Unit]
Description=/etc/rc.local Compatibility
After=network.target

[Service]
Type=forking
ExecStart=/etc/rc.local start
TimeoutSec=0
RemainAfterExit=yes
GuessMainPID=no

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable rc-local
systemctl start rc-local

# Asterisk Sounds
cd /usr/src
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-core-sounds-en-ulaw-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-core-sounds-en-wav-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-core-sounds-en-gsm-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-extra-sounds-en-ulaw-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-extra-sounds-en-wav-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-extra-sounds-en-gsm-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-moh-opsound-gsm-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-moh-opsound-ulaw-current.tar.gz
wget http://downloads.asterisk.org/pub/telephony/sounds/asterisk-moh-opsound-wav-current.tar.gz

mkdir -p /var/lib/asterisk/sounds
cd /var/lib/asterisk/sounds
for sound in /usr/src/asterisk-*-en-*.tar.gz; do
    tar -zxf "$sound"
done

mkdir -p /var/lib/asterisk/mohmp3
cd /var/lib/asterisk/mohmp3
tar -zxf /usr/src/asterisk-moh-opsound-gsm-current.tar.gz
tar -zxf /usr/src/asterisk-moh-opsound-ulaw-current.tar.gz
tar -zxf /usr/src/asterisk-moh-opsound-wav-current.tar.gz

# Codec G729 (64-bit Debian)
cd /usr/lib/x86_64-linux-gnu/asterisk/modules 2>/dev/null || \
    cd /usr/lib/asterisk/modules
wget http://asterisk.hosting.lv/bin/codec_g729-ast160-gcc4-glibc-x86_64-core2-sse4.so -O codec_g729.so
chmod 755 codec_g729.so

# Apache Recordings-Alias
cat >> /etc/apache2/apache2.conf <<EOF
Alias /RECORDINGS/MP3 "/var/spool/asterisk/monitorDONE/MP3/"
<Directory "/var/spool/asterisk/monitorDONE/MP3/">
    Options Indexes MultiViews
    AllowOverride None
    Require all granted
</Directory>
EOF

# Berechtigungen
mkdir -p /var/spool/asterisk/monitor /var/spool/asterisk/monitorDONE/MP3
chown -R asterisk:asterisk /var/spool/asterisk 2>/dev/null || \
    chown -R www-data:www-data /var/spool/asterisk
chmod -R 755 /var/spool/asterisk

systemctl restart apache2

# Welcome-Seite
cat > /var/www/html/index.html <<WELCOME
<META HTTP-EQUIV=REFRESH CONTENT="1; URL=/vicidial/welcome.php">
Bitte warten, Weiterleitung...
WELCOME

echo "========================================="
echo "=== VICIDIAL INSTALLATION ABGESCHLOSSEN ==="
echo "========================================="
echo ""
echo "ViciDial erreichbar unter: http://$ip_address/agc/vicidial.php"
echo "Login:    6666"
echo "Passwort: 1234"
echo ""
echo "MySQL cron-Benutzer: cron / 1234"
echo ""
echo "NÄCHSTE SCHRITTE:"
echo "1. Firewall manuell konfigurieren:"
echo "   ufw allow 80/tcp"
echo "   ufw allow 443/tcp"
echo "   ufw allow 5060/udp"
echo "   ufw enable"
echo ""
echo "2. Standard-Passwörter im ViciDial-Admin ändern!"
echo ""
echo "3. MySQL root absichern: mysql_secure_installation"
echo ""
echo "========================================="

read -p 'Enter drücken zum Neustarten: '
reboot
