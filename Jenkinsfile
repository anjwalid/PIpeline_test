// =============================================================
// AWB PIPELINE TEST - BUILD + PUSH HARBOR + DEPLOY ONLY
// =============================================================

def buildStatus  = "PENDING"
def deployStatus = "PENDING"

pipeline {
agent any

```
options {
    timestamps()
    timeout(time: 1, unit: 'HOURS')
    buildDiscarder(logRotator(numToKeepStr: '20'))
    disableConcurrentBuilds()
}

parameters {
    booleanParam(
        name: 'SKIP_DEPLOY',
        defaultValue: false,
        description: 'Sauter le deploiement et tester seulement build + push Harbor'
    )
}

environment {
    REPORTS_DIR = "/opt/ai-security/app-pipeline/reports"

    IMAGE_TAG = "${BUILD_NUMBER}"

    HARBOR_REGISTRY = "206.189.31.29:11180"
    HARBOR_PROJECT  = "awb"

    BACKEND_IMAGE  = "${HARBOR_REGISTRY}/${HARBOR_PROJECT}/awb-backend"
    FRONTEND_IMAGE = "${HARBOR_REGISTRY}/${HARBOR_PROJECT}/awb-frontend"

    APP_SERVICES = "backend frontend"
    MONITORING_SERVICES = "prometheus grafana"
    PROTECTED_CONTAINERS = "postgres_db keycloak node-exporter"
}

stages {

    stage('Build Docker Images') {
        steps {
            withCredentials([string(credentialsId: 'vm-desktop-ip', variable: 'VM_IP')]) {
                sh '''
                    set -e

                    echo "[*] === Build images applicatives uniquement ==="
                    echo "Backend image  : ${BACKEND_IMAGE}:${IMAGE_TAG}"
                    echo "Frontend image : ${FRONTEND_IMAGE}:${IMAGE_TAG}"

                    echo "[*] Build backend..."
                    docker build -t ${BACKEND_IMAGE}:${IMAGE_TAG} ./backend
                    docker tag ${BACKEND_IMAGE}:${IMAGE_TAG} ${BACKEND_IMAGE}:latest

                    echo "[*] Build frontend..."
                    docker build \
                        --build-arg VITE_API_BASE_URL=http://${VM_IP}:8000 \
                        --build-arg VITE_KEYCLOAK_URL=http://${VM_IP}:8080 \
                        --build-arg VITE_KEYCLOAK_REALM=myrealm \
                        --build-arg VITE_KEYCLOAK_CLIENT_ID=frontend-app \
                        -t ${FRONTEND_IMAGE}:${IMAGE_TAG} ./frontend

                    docker tag ${FRONTEND_IMAGE}:${IMAGE_TAG} ${FRONTEND_IMAGE}:latest

                    echo "[*] Images buildees:"
                    docker images | grep "${HARBOR_REGISTRY}/${HARBOR_PROJECT}" || true
                '''
            }
        }
        post {
            success {
                script { buildStatus = "PASS" }
            }
            failure {
                script { buildStatus = "FAIL" }
            }
        }
    }

    stage('Push Harbor') {
        steps {
            withCredentials([usernamePassword(
                credentialsId: 'harbor-creds',
                usernameVariable: 'HARBOR_USER',
                passwordVariable: 'HARBOR_PASS'
            )]) {
                sh '''
                    set -e

                    echo "[*] === Test connectivite Harbor ==="
                    curl -v --connect-timeout 10 http://${HARBOR_REGISTRY}/v2/ || true

                    echo "[*] === Login Harbor ==="
                    docker logout ${HARBOR_REGISTRY} || true

                    echo "${HARBOR_PASS}" | docker login ${HARBOR_REGISTRY} \
                        -u "${HARBOR_USER}" \
                        --password-stdin

                    echo "[*] === Push images vers Harbor ==="

                    push_with_retry () {
                        for i in 1 2 3 4 5; do
                            echo "[*] Push attempt $i: $1"
                            docker push $1 && return 0
                            echo "Push failed, retry $i..."
                            sleep 20
                        done
                        echo "FATAL: push failed: $1"
                        exit 1
                    }

                    push_with_retry ${BACKEND_IMAGE}:${IMAGE_TAG}
                    push_with_retry ${BACKEND_IMAGE}:latest
                    push_with_retry ${FRONTEND_IMAGE}:${IMAGE_TAG}
                    push_with_retry ${FRONTEND_IMAGE}:latest

                    echo "[*] === Verification pull depuis Harbor ==="
                    docker pull ${BACKEND_IMAGE}:${IMAGE_TAG}
                    docker pull ${FRONTEND_IMAGE}:${IMAGE_TAG}

                    docker logout ${HARBOR_REGISTRY}

                    echo "[OK] Push Harbor termine avec succes"
                '''
            }
        }
    }

    stage('Deploy VM Desktop') {
        when {
            expression { return params.SKIP_DEPLOY == false }
        }
        steps {
            withCredentials([
                sshUserPrivateKey(
                    credentialsId: 'vm-desktop-ssh',
                    keyFileVariable: 'SSH_KEY',
                    usernameVariable: 'SSH_USER'
                ),
                string(credentialsId: 'vm-desktop-ip', variable: 'VM_IP'),
                file(credentialsId: 'app-backend-env', variable: 'BACKEND_ENV_FILE'),
                file(credentialsId: 'app-root-env', variable: 'ROOT_ENV_FILE'),
                usernamePassword(
                    credentialsId: 'harbor-creds',
                    usernameVariable: 'HARBOR_USER',
                    passwordVariable: 'HARBOR_PASS'
                )
            ]) {
                sh '''
                    set -e

                    mkdir -p ${REPORTS_DIR}/deploy

                    echo "[*] === Deploy -> ${VM_IP} ==="

                    echo "[*] Test SSH..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        -o ConnectTimeout=10 \
                        ${SSH_USER}@${VM_IP} "echo SSH OK && hostname"

                    echo "[*] Snapshot containers proteges AVANT..."
                    PROTECTED_REGEX=$(echo "${PROTECTED_CONTAINERS}" | sed 's/ /|/g')

                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "docker ps --format '{{.Names}}|{{.ID}}'" \
                        | grep -E "^(${PROTECTED_REGEX})\\|" \
                        | sort > ${REPORTS_DIR}/deploy/protected_before.txt || true

                    cat ${REPORTS_DIR}/deploy/protected_before.txt || true

                    echo "[*] Verification docker-compose.prod.yml local..."
                    test -f docker-compose.prod.yml

                    LOCAL_DECLARED=$(docker compose -f docker-compose.prod.yml config --services | sort | xargs)
                    echo "Services compose local: '${LOCAL_DECLARED}'"

                    for svc in ${APP_SERVICES}; do
                        if ! echo "${LOCAL_DECLARED}" | grep -qw "${svc}"; then
                            echo "FATAL: service '${svc}' absent du compose local"
                            exit 1
                        fi
                    done

                    for risky in postgres postgresql postgres_db db database keycloak auth identity node-exporter exporter prometheus; do
                        if echo "${LOCAL_DECLARED}" | grep -qw "${risky}"; then
                            MATCH=0
                            for app in ${APP_SERVICES}; do
                                [ "$app" = "$risky" ] && MATCH=1
                            done

                            if [ "$MATCH" -eq 0 ]; then
                                echo "FATAL: compose declare service interdit '${risky}'"
                                exit 1
                            fi
                        fi
                    done

                    echo "[*] Preparation repertoire distant..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "mkdir -p ~/awb-deploy && \
                         chmod -R u+w ~/awb-deploy/ 2>/dev/null || true && \
                         rm -f ~/awb-deploy/backend.env ~/awb-deploy/.env ~/awb-deploy/docker-compose.yml || true"

                    echo "[*] Copie docker-compose + env..."
                    scp -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        docker-compose.prod.yml \
                        ${SSH_USER}@${VM_IP}:~/awb-deploy/docker-compose.yml

                    scp -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${BACKEND_ENV_FILE} \
                        ${SSH_USER}@${VM_IP}:~/awb-deploy/backend.env

                    scp -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${ROOT_ENV_FILE} \
                        ${SSH_USER}@${VM_IP}:~/awb-deploy/.env

                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "chmod 600 ~/awb-deploy/backend.env ~/awb-deploy/.env"

                    echo "[*] Update .env distant..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && \
                         grep -q '^BUILD_TAG=' .env && sed -i 's|^BUILD_TAG=.*|BUILD_TAG=${IMAGE_TAG}|' .env || echo 'BUILD_TAG=${IMAGE_TAG}' >> .env && \
                         grep -q '^HARBOR_REGISTRY=' .env && sed -i 's|^HARBOR_REGISTRY=.*|HARBOR_REGISTRY=${HARBOR_REGISTRY}|' .env || echo 'HARBOR_REGISTRY=${HARBOR_REGISTRY}' >> .env && \
                         grep -q '^HARBOR_PROJECT=' .env && sed -i 's|^HARBOR_PROJECT=.*|HARBOR_PROJECT=${HARBOR_PROJECT}|' .env || echo 'HARBOR_PROJECT=${HARBOR_PROJECT}' >> .env && \
                         grep -E '^(BUILD_TAG|HARBOR_REGISTRY|HARBOR_PROJECT)=' .env"

                    echo "[*] Login Harbor sur VM distante..."
                    echo "${HARBOR_PASS}" | ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "docker login ${HARBOR_REGISTRY} -u '${HARBOR_USER}' --password-stdin"

                    echo "[*] Verification compose distant..."
                    DECLARED=$(ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && docker compose config --services" | sort | xargs)

                    echo "Services compose distant: '${DECLARED}'"

                    for svc in ${APP_SERVICES}; do
                        if ! echo "${DECLARED}" | grep -qw "${svc}"; then
                            echo "FATAL: service '${svc}' absent du compose distant"
                            exit 1
                        fi
                    done

                    for p in ${PROTECTED_CONTAINERS}; do
                        if echo "${DECLARED}" | grep -qw "${p}"; then
                            echo "FATAL: compose distant declare '${p}' container PROTEGE"
                            exit 1
                        fi
                    done

                    echo "[*] Pull images depuis Harbor..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && docker compose pull ${APP_SERVICES}"

                    echo "[*] Recreate backend/frontend uniquement..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && docker compose up -d --no-deps --force-recreate ${APP_SERVICES}" \
                        | tee ${REPORTS_DIR}/deploy/deploy.log

                    echo "[*] Snapshot containers proteges APRES..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "docker ps --format '{{.Names}}|{{.ID}}'" \
                        | grep -E "^(${PROTECTED_REGEX})\\|" \
                        | sort > ${REPORTS_DIR}/deploy/protected_after.txt || true

                    cat ${REPORTS_DIR}/deploy/protected_after.txt || true

                    if diff -q ${REPORTS_DIR}/deploy/protected_before.txt \
                               ${REPORTS_DIR}/deploy/protected_after.txt > /dev/null; then
                        echo "OK : containers proteges INTACTS"
                    else
                        echo "ALERTE : un container protege a bouge !"
                        diff ${REPORTS_DIR}/deploy/protected_before.txt \
                             ${REPORTS_DIR}/deploy/protected_after.txt || true
                        exit 1
                    fi

                    echo "[*] Etat final containers:"
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}'"
                '''
            }
        }
        post {
            success {
                script { deployStatus = "PASS" }
            }
            failure {
                script { deployStatus = "FAIL" }
            }
        }
    }

    stage('Deploy Monitoring') {
        when {
            expression { return params.SKIP_DEPLOY == false }
        }
        steps {
            withCredentials([
                string(credentialsId: 'vm-desktop-ip', variable: 'VM_IP'),
                sshUserPrivateKey(
                    credentialsId: 'vm-desktop-ssh',
                    keyFileVariable: 'SSH_KEY',
                    usernameVariable: 'SSH_USER'
                )
            ]) {
                sh '''
                    set -e

                    mkdir -p ${REPORTS_DIR}/deploy

                    echo "[*] Preparation monitoring sur VM distante..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "mkdir -p ~/awb-deploy/monitoring/prometheus ~/awb-deploy/monitoring/grafana && \
                         rm -f ~/awb-deploy/docker-compose.monitoring.yml ~/awb-deploy/monitoring/prometheus/prometheus.yml && \
                         rm -rf ~/awb-deploy/monitoring/grafana/provisioning"

                    echo "[*] Copie fichiers monitoring..."
                    scp -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        docker-compose.monitoring.yml \
                        ${SSH_USER}@${VM_IP}:~/awb-deploy/docker-compose.monitoring.yml

                    scp -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        monitoring/prometheus/prometheus.yml \
                        ${SSH_USER}@${VM_IP}:~/awb-deploy/monitoring/prometheus/prometheus.yml

                    scp -i ${SSH_KEY} -o StrictHostKeyChecking=no -r \
                        monitoring/grafana/provisioning \
                        ${SSH_USER}@${VM_IP}:~/awb-deploy/monitoring/grafana/

                    echo "[*] Verification compose monitoring..."
                    MON_DECLARED=$(ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && docker compose -f docker-compose.monitoring.yml config --services" | sort | xargs)

                    echo "Services monitoring distants: '${MON_DECLARED}'"

                    for svc in ${MONITORING_SERVICES}; do
                        if ! echo "${MON_DECLARED}" | grep -qw "${svc}"; then
                            echo "FATAL: service monitoring '${svc}' absent du compose distant"
                            exit 1
                        fi
                    done

                    for forbidden in backend frontend postgres_db postgres keycloak node-exporter; do
                        if echo "${MON_DECLARED}" | grep -qw "${forbidden}"; then
                            echo "FATAL: compose monitoring declare service interdit '${forbidden}'"
                            exit 1
                        fi
                    done

                    echo "[*] Pull images monitoring..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && docker compose -f docker-compose.monitoring.yml pull ${MONITORING_SERVICES}"

                    echo "[*] Demarrage monitoring..."
                    ssh -i ${SSH_KEY} -o StrictHostKeyChecking=no \
                        ${SSH_USER}@${VM_IP} \
                        "cd ~/awb-deploy && docker compose -f docker-compose.monitoring.yml up -d ${MONITORING_SERVICES}" \
                        | tee ${REPORTS_DIR}/deploy/monitoring-deploy.log
                '''
            }
        }
        post {
            failure {
                script { deployStatus = "FAIL" }
            }
        }
    }

    stage('Health Check') {
        when {
            expression { return params.SKIP_DEPLOY == false }
        }
        steps {
            withCredentials([string(credentialsId: 'vm-desktop-ip', variable: 'VM_IP')]) {
                sh '''
                    set +e

                    mkdir -p ${REPORTS_DIR}/deploy

                    echo "[*] Wait 15s..."
                    sleep 15

                    for endpoint in \
                        "http://${VM_IP}:8000/docs" \
                        "http://${VM_IP}:5173" \
                        "http://${VM_IP}:8080" \
                        "http://${VM_IP}:9090" \
                        "http://${VM_IP}:3000/login"
                    do
                        CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 ${endpoint})
                        echo "${endpoint} -> HTTP ${CODE}"
                    done | tee ${REPORTS_DIR}/deploy/health.log
                '''
            }
        }
    }
}

post {
    always {
        script {
            if (buildStatus == "PENDING") {
                buildStatus = "NOT_REACHED"
            }

            if (deployStatus == "PENDING") {
                deployStatus = params.SKIP_DEPLOY ? "SKIPPED" : "NOT_REACHED"
            }

            echo "============================================================"
            echo "Build status  : ${buildStatus}"
            echo "Deploy status : ${deployStatus}"
            echo "Build number  : ${env.BUILD_NUMBER}"
            echo "Backend image : ${env.BACKEND_IMAGE}:${env.IMAGE_TAG}"
            echo "Frontend image: ${env.FRONTEND_IMAGE}:${env.IMAGE_TAG}"
            echo "============================================================"
        }

        sh '''
            mkdir -p ${WORKSPACE}/reports
            cp -r ${REPORTS_DIR}/* ${WORKSPACE}/reports/ 2>/dev/null || true
        '''

        archiveArtifacts artifacts: 'reports/**/*', allowEmptyArchive: true, fingerprint: true
    }

    success {
        echo "AWB PIPELINE TEST : SUCCESS"
    }

    failure {
        echo "AWB PIPELINE TEST : FAILED"
    }
}
```

}
