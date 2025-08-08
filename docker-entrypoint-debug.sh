#!/bin/sh
# Debug entrypoint for lens-node containers with interactive console

set -e

# Check if this is the first run (no config.json exists)
if [ ! -f /root/.lens-node/config.json ]; then
    echo "First run detected. Running lens-node setup..."
    
    # Determine which site to create based on container name
    if [ "$HOSTNAME" = "lens-node-primary" ]; then
        echo "Setting up Primary Site (Lens 1)..."
        printf "Primary Site\nPrimary test site with relay enabled\n" | node /app/dist/cli/bin.js setup -d /root/.lens-node
        
        if [ -f /root/.lens-node/config.json ]; then
            SITE_ADDRESS=$(cat /root/.lens-node/config.json | grep address | cut -d'"' -f4)
            echo "$SITE_ADDRESS" > /shared/primary-site-address.txt
            echo "Shared Primary Site address: $SITE_ADDRESS"
        fi
        
    elif [ "$HOSTNAME" = "lens-node-light" ]; then
        echo "Setting up Light Node/CDN (Lens 2) - Will import Primary Site..."
        
        for i in $(seq 1 30); do
            if [ -f /shared/primary-site-address.txt ]; then
                SITE_ADDRESS=$(cat /shared/primary-site-address.txt)
                echo "Importing Primary Site address: $SITE_ADDRESS"
                printf "$SITE_ADDRESS\n" | node /app/dist/cli/bin.js import -d /root/.lens-node
                break
            fi
            echo "Waiting for primary site... ($i/30)"
            sleep 1
        done
        
        if [ ! -f /root/.lens-node/config.json ]; then
            echo "ERROR: Primary site address not found or import failed after 30 seconds"
            exit 1
        fi
        
    elif [ "$HOSTNAME" = "lens-node-federated" ]; then
        echo "Setting up Independent Federated Site (Lens 3)..."
        printf "Federated Site\nIndependent site that will follow Primary via federation\n" | node /app/dist/cli/bin.js setup -d /root/.lens-node
        
        if [ -f /root/.lens-node/config.json ]; then
            SITE_ADDRESS=$(cat /root/.lens-node/config.json | grep address | cut -d'"' -f4)
            echo "$SITE_ADDRESS" > /shared/federated-site-address.txt
            echo "Shared Federated Site address: $SITE_ADDRESS"
            echo "NOTE: Federated site created. Use the admin interface to follow the Primary Site."
        fi
    fi
fi

# Run with node inspect for debugging
echo "Starting lens-node with debugging enabled on port 9229..."
echo "You can attach a debugger or use Chrome DevTools at chrome://inspect"
exec node --inspect=0.0.0.0:9229 /app/dist/cli/bin.js "$@"