+++
Categories = ["MySQL", "Backup"]
Tags = ["mysql", "backup"]
date = "2021-02-18T15:37:00+00:00"
more_link = "yes"
title = "How to Backup MySQL using automysqlbackup"
+++

AutoMySQLBackup is a free and open-source tool that can be used to create backups of your MySQL databases at varying intervals, such as daily, weekly, and monthly. It uses mysqldump to create backups of one or more MySQL databases from one or more MySQL servers. It provides many features such as email notification, incremental database backups, backup compression and encryption, and much more.

<!--more-->
# [Install](#install)

Regarding the user that you are using to back up the database, you have two options. You can use a user that has read/write privileges on all of the databases (Less Secure) or set up a new user with read-only access on all of the databases (More Secure).

```
mysql -uroot -p
GRANT LOCK TABLES, SELECT ON *.* TO 'BACKUPUSER'@'%' IDENTIFIED BY 'PASSWORD';
flush privileges;
```

Note: You'll want to create a random password using Uppercase, Lowercase, and Numbers but no symbols. I recommend using [Password Generator](https://passwordsgenerator.net)

To install, type the following into the terminal:
```
sudo apt-get install automysqlbackup
```

The following prompt will ask you which mail configuration you prefer. Select "internet site" if you're going to set up an email notification. If not, select "no configuration." I went for "no configuration" to leave things unchanged.

Start automysqlbackup:
```
sudo automysqlbackup
```

A folder structure and initial backups will be performed immediately. The default location for backups is /var/lib/automysqlbackup.

List contents of this directory to see the folder structure:
```
ls -lh /var/lib/automysqlbackup
```

You should see three directories for the daily, weekly, and monthly backups being performed automatically by automysqlbackup and a subdirectory for each database containing the respective gzipped SQL dump.

The configuration file for automysqlbackup is located at /etc/default/automysqlbackup. Open it in your favorite editor:
```
sudo nano /etc/default/automysqlbackup
```

We'll want to change USERNAME and PASSWORD to match the user account we created earlier.
