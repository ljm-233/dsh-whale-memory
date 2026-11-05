[Unit]
Description=DSH group-history incremental dump (whale-memory layer 2)

[Service]
Type=oneshot
WorkingDirectory=__HOME__/.dsh/im/whale-memory
ExecStart=__NODE__ __HOME__/.dsh/im/whale-memory/scripts/dump-group.mjs
