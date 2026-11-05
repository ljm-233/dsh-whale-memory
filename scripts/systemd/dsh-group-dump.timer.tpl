[Unit]
Description=Run dsh-group-dump every __INTERVAL_MIN__ minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=__INTERVAL_MIN__min
Persistent=true

[Install]
WantedBy=timers.target
