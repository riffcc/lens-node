#!/bin/sh
# Docker entrypoint for lens-node containers

set -e

# Wait for relay to share its multiaddr (up to 30 seconds)
echo "Waiting for relay to start and share its multiaddr..."
for i in $(seq 1 30); do
    if [ -f /shared/relay-multiaddr.txt ]; then
        RELAY_MULTIADDR=$(cat /shared/relay-multiaddr.txt)
        echo "Found relay multiaddr: $RELAY_MULTIADDR"
        export BOOTSTRAPPERS="$RELAY_MULTIADDR"
        break
    fi
    echo "Waiting for relay... ($i/30)"
    sleep 1
done

if [ -z "$BOOTSTRAPPERS" ]; then
    echo "WARNING: Relay multiaddr not found after 30 seconds, continuing without bootstrappers"
fi

# Check if this is the first run (no config.json exists)
if [ ! -f /root/.lens-node/config.json ]; then
    echo "First run detected. Running lens-node setup..."
    
    # Determine which site to create based on container name
    if [ "$HOSTNAME" = "lens-node-primary" ]; then
        echo "Setting up Primary Site (Lens 1)..."
        # Setup creates a new Site with interactive prompts, we'll provide answers via printf
        # Capture output to extract Peer ID
        printf "Primary Site\nPrimary test site with relay enabled\n" | node /app/dist/cli/bin.js setup -d /root/.lens-node | tee /tmp/setup-output.txt
        
        # Extract the Peer ID from setup output
        PEER_ID=$(grep "^Peer ID:" /tmp/setup-output.txt | awk '{print $3}')
        if [ -n "$PEER_ID" ]; then
            echo "$PEER_ID" > /shared/primary-peer-id.txt
            # WebSocket port is listenPort+1, so 9500+1=9501
            echo "/ip4/127.0.0.1/tcp/9501/ws/p2p/$PEER_ID" > /shared/primary-multiaddr.txt
            echo "Captured Primary Node Peer ID: $PEER_ID"
        fi
        
        # After setup, share the site address for lens-node-light to import
        if [ -f /root/.lens-node/config.json ]; then
            SITE_ADDRESS=$(cat /root/.lens-node/config.json | grep address | cut -d'"' -f4)
            echo "$SITE_ADDRESS" > /shared/primary-site-address.txt
            echo "Shared Primary Site address: $SITE_ADDRESS"
        fi
        
    elif [ "$HOSTNAME" = "lens-node-light" ]; then
        echo "Setting up Light Node/CDN (Lens 2) - Will import Primary Site..."
        
        # Wait up to 30 seconds for primary to create the site
        for i in $(seq 1 30); do
            if [ -f /shared/primary-site-address.txt ]; then
                SITE_ADDRESS=$(cat /shared/primary-site-address.txt)
                echo "Importing Primary Site address: $SITE_ADDRESS"
                # Use lens-node import command and capture output to extract Peer ID
                printf "$SITE_ADDRESS\n" | node /app/dist/cli/bin.js import -d /root/.lens-node | tee /tmp/import-output.txt
                
                # Extract the Peer ID from the import output
                PEER_ID=$(grep "^Peer ID:" /tmp/import-output.txt | awk '{print $3}')
                if [ -n "$PEER_ID" ]; then
                    echo "$PEER_ID" > /shared/light-peer-id.txt
                    # WebSocket port is listenPort+1, so 9502+1=9503
                    echo "/ip4/127.0.0.1/tcp/9503/ws/p2p/$PEER_ID" > /shared/light-multiaddr.txt
                    echo "Captured Light Node Peer ID: $PEER_ID"
                fi
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
        # Create its own independent site
        # Capture output to extract Peer ID
        printf "Federated Site\nIndependent site that will follow Primary via federation\n" | node /app/dist/cli/bin.js setup -d /root/.lens-node | tee /tmp/setup-output.txt
        
        # Extract the Peer ID from setup output
        PEER_ID=$(grep "^Peer ID:" /tmp/setup-output.txt | awk '{print $3}')
        if [ -n "$PEER_ID" ]; then
            echo "$PEER_ID" > /shared/federated-peer-id.txt
            # WebSocket port is listenPort+1, so 9504+1=9505
            echo "/ip4/127.0.0.1/tcp/9505/ws/p2p/$PEER_ID" > /shared/federated-multiaddr.txt
            echo "Captured Federated Node Peer ID: $PEER_ID"
        fi
        
        # After setup, share this site's address
        if [ -f /root/.lens-node/config.json ]; then
            SITE_ADDRESS=$(cat /root/.lens-node/config.json | grep address | cut -d'"' -f4)
            echo "$SITE_ADDRESS" > /shared/federated-site-address.txt
            echo "Shared Federated Site address: $SITE_ADDRESS"
            
            # TODO: After setup, this site needs to follow the primary site via federation
            # This would be done through the API or admin interface after startup
            echo "NOTE: Federated site created. Use the admin interface to follow the Primary Site."
        fi
    fi
fi

# Now run the actual lens-node command
# Peer IDs were already captured during setup/import above
exec node /app/dist/cli/bin.js "$@"